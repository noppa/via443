import http from 'node:http';
import {
  closeArgs,
  decodeRequestHead,
  decodeReset,
  decodeWindow,
  decodeWsClose,
  decodeWsOpen,
  encodeBody,
  encodeReset,
  encodeResponseHead,
  encodeWindow,
  type Frame,
  FrameType,
  type HeaderList,
  isEnd,
  MAX_CHUNK_SIZE,
  MAX_WS_MESSAGE,
  ReceiveWindow,
  type RequestHead,
  SendWindow,
  stripHopByHop,
  WsReceiver,
  WsSender,
} from '@via443/protocol';
import WebSocket from 'ws';

export interface LocalTarget {
  host: string;
  port: number;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number | undefined;
  durationMs: number;
  error?: string;
}

interface LocalStream {
  request: http.ClientRequest;
  response?: http.IncomingMessage;
  done: boolean;
  /** Credit the relay has for sending the request body. */
  uploadWindow: ReceiveWindow;
  /** Credit for sending the response body. */
  downloadWindow: SendWindow;
}

interface LocalWebSocket {
  ws: WebSocket;
  sender: WsSender;
  receiver: WsReceiver;
}

const NO_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Replays requests that arrive over the tunnel against the local server and
 * streams the responses back as frames.
 */
export class LocalForwarder {
  readonly #streams = new Map<number, LocalStream>();
  readonly #webSockets = new Map<number, LocalWebSocket>();
  readonly #target: LocalTarget;
  readonly #send: (frame: Frame) => void;
  readonly #onRequest: (entry: RequestLogEntry) => void;

  constructor(target: LocalTarget, send: (frame: Frame) => void, onRequest: (entry: RequestLogEntry) => void = () => {}) {
    this.#target = target;
    this.#send = send;
    this.#onRequest = onRequest;
  }

  get activeStreams(): number {
    return this.#streams.size + this.#webSockets.size;
  }

  /** Handles a per-stream frame from the relay. */
  handle(frame: Frame): void {
    switch (frame.type) {
      case FrameType.REQ_HEAD:
        this.#start(frame.streamId, decodeRequestHead(frame), isEnd(frame));
        return;
      case FrameType.REQ_BODY: {
        const stream = this.#streams.get(frame.streamId);
        if (!stream) return;
        const bytes = frame.payload.byteLength;
        stream.uploadWindow.received(bytes);
        if (bytes > 0) {
          // The callback runs once the chunk is handed to the local socket; only then may the relay send more.
          stream.request.write(frame.payload, () => {
            if (stream.done) return;
            const increment = stream.uploadWindow.consumed(bytes);
            if (increment > 0) this.#send(encodeWindow(frame.streamId, increment));
          });
        }
        if (isEnd(frame)) stream.request.end();
        return;
      }
      case FrameType.WINDOW: {
        const increment = decodeWindow(frame);
        this.#streams.get(frame.streamId)?.downloadWindow.grant(increment);
        this.#webSockets.get(frame.streamId)?.sender.window.grant(increment);
        return;
      }
      case FrameType.RESET: {
        decodeReset(frame);
        this.#abort(frame.streamId);
        return;
      }
      case FrameType.WS_OPEN:
        this.#openWebSocket(frame.streamId, decodeWsOpen(frame));
        return;
      case FrameType.WS_MSG:
        this.#webSockets.get(frame.streamId)?.receiver.receive(frame);
        return;
      case FrameType.WS_CLOSE: {
        const close = decodeWsClose(frame);
        const local = this.#webSockets.get(frame.streamId);
        if (!local) return;
        this.#closeWebSocket(frame.streamId);
        local.ws.close(...closeArgs(close));
        return;
      }
    }
  }

  /** Drops every open stream, e.g. because the tunnel connection was lost. */
  abortAll(): void {
    for (const streamId of [...this.#streams.keys(), ...this.#webSockets.keys()]) this.#abort(streamId);
  }

  #start(streamId: number, head: RequestHead, end: boolean): void {
    const started = performance.now();
    const log = (status: number | undefined, error?: string) =>
      this.#onRequest({ method: head.method, path: head.path, status, durationMs: performance.now() - started, error });

    const request = http.request({
      host: this.#target.host,
      port: this.#target.port,
      method: head.method,
      path: head.path,
      headers: flatten(localRequestHeaders(head.headers, this.#target)),
      setHost: false,
    });
    const stream: LocalStream = {
      request,
      done: false,
      uploadWindow: new ReceiveWindow(),
      downloadWindow: new SendWindow(),
    };
    this.#streams.set(streamId, stream);

    request.on('response', (response) => this.#respond(streamId, stream, head, response, log));
    request.on('error', (err) => this.#fail(streamId, err, () => log(undefined, describeError(err))));
    if (end) request.end();
  }

  /** Sends the local server's response back through the tunnel. */
  #respond(
    streamId: number,
    stream: LocalStream,
    head: RequestHead,
    response: http.IncomingMessage,
    log: (status: number | undefined, error?: string) => void,
  ): void {
    stream.response = response;
    const noBody = head.method === 'HEAD' || NO_BODY_STATUSES.has(response.statusCode ?? 0);
    const headers = stripHopByHop(pairs(response.rawHeaders));
    this.#send(encodeResponseHead(streamId, { status: response.statusCode ?? 502, headers }, noBody));
    if (noBody) {
      response.resume();
      this.#complete(streamId);
      log(response.statusCode);
      return;
    }
    void this.#sendBody(streamId, stream, response).then(
      (completed) => {
        if (completed) log(response.statusCode);
      },
      (err: Error) => this.#fail(streamId, err, () => log(response.statusCode, err.message)),
    );
  }

  /**
   * Opens a WebSocket to the local server for a visitor's upgrade request and
   * answers RES_HEAD 101 once it's open. If the local server answers with
   * anything other than an upgrade, that response is passed on instead.
   */
  #openWebSocket(streamId: number, head: RequestHead): void {
    const started = performance.now();
    const log = (status: number | undefined, error?: string) =>
      this.#onRequest({ method: head.method, path: head.path, status, durationMs: performance.now() - started, error });

    const protocols: string[] = [];
    const headers: Record<string, string[]> = {};
    for (const [name, value] of localRequestHeaders(head.headers, this.#target)) {
      const lower = name.toLowerCase();
      if (lower === 'sec-websocket-protocol') {
        protocols.push(...value.split(',').map((p) => p.trim()).filter(Boolean));
      } else if (!lower.startsWith('sec-websocket-')) {
        // Key, version and extensions belong to the visitor's hop; ws negotiates its own.
        (headers[lower] ??= []).push(value);
      }
    }

    const host = this.#target.host.includes(':') ? `[${this.#target.host}]` : this.#target.host;
    const ws = new WebSocket(`ws://${host}:${this.#target.port}${head.path}`, protocols, {
      headers,
      perMessageDeflate: false,
      maxPayload: MAX_WS_MESSAGE,
    });
    const local: LocalWebSocket = {
      ws,
      sender: new WsSender(
        streamId,
        (frame) => {
          this.#send(frame);
          if (frame.type === FrameType.WS_CLOSE) this.#closeWebSocket(streamId);
        },
        (paused) => (paused ? ws.pause() : ws.resume()),
      ),
      receiver: new WsReceiver(streamId, this.#send, (data, sent) => ws.send(data, () => sent())),
    };
    this.#webSockets.set(streamId, local);

    let opened = false;
    let failure: string | undefined;
    ws.on('open', () => {
      opened = true;
      const headers: HeaderList = ws.protocol ? [['sec-websocket-protocol', ws.protocol]] : [];
      this.#send(encodeResponseHead(streamId, { status: 101, headers }, false));
      log(101);
    });
    ws.on('unexpected-response', (request, response) => {
      // Not an upgrade: carry on as a plain HTTP stream.
      this.#webSockets.delete(streamId);
      const stream: LocalStream = {
        request,
        done: false,
        uploadWindow: new ReceiveWindow(),
        downloadWindow: new SendWindow(),
      };
      this.#streams.set(streamId, stream);
      this.#respond(streamId, stream, head, response, log);
    });
    ws.on('message', (data: Buffer, isBinary) => local.sender.message(isBinary ? data : data.toString()));
    ws.on('error', (err) => (failure = describeError(err)));
    ws.on('close', (code, reason) => {
      if (!this.#webSockets.has(streamId)) return;
      if (!opened) {
        const message = failure ?? 'connection closed';
        this.#send(encodeReset(streamId, { code: 'upstream_error', message }));
        this.#closeWebSocket(streamId);
        log(undefined, message);
        return;
      }
      local.receiver.abort();
      local.sender.close({ code, reason: reason.toString() });
    });
  }

  /** Forgets a WebSocket stream; nothing more is sent or expected on it. */
  #closeWebSocket(streamId: number): void {
    const local = this.#webSockets.get(streamId);
    if (!local) return;
    this.#webSockets.delete(streamId);
    local.sender.abort();
    local.receiver.abort();
  }

  /**
   * Streams the local response body to the relay, pausing it while the relay's
   * window is used up. Resolves false if the stream was aborted on the way.
   */
  async #sendBody(streamId: number, stream: LocalStream, response: http.IncomingMessage): Promise<boolean> {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      for (let offset = 0; offset < chunk.byteLength; ) {
        const bytes = await stream.downloadWindow.take(Math.min(MAX_CHUNK_SIZE, chunk.byteLength - offset));
        if (stream.done || bytes === 0) return false;
        this.#send(encodeBody(FrameType.RES_BODY, streamId, chunk.subarray(offset, offset + bytes), false));
        offset += bytes;
      }
    }
    if (stream.done) return false;
    this.#send(encodeBody(FrameType.RES_BODY, streamId, new Uint8Array(), true));
    this.#complete(streamId);
    return true;
  }

  #fail(streamId: number, err: Error, log: () => void): void {
    const stream = this.#streams.get(streamId);
    if (!stream || stream.done) return;
    this.#send(encodeReset(streamId, { code: 'upstream_error', message: describeError(err) }));
    this.#complete(streamId);
    log();
  }

  #abort(streamId: number): void {
    const local = this.#webSockets.get(streamId);
    if (local) {
      this.#closeWebSocket(streamId);
      local.ws.terminate();
      return;
    }
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#complete(streamId);
    stream.request.destroy();
    stream.response?.destroy();
  }

  #complete(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    stream.done = true;
    stream.downloadWindow.close();
    this.#streams.delete(streamId);
  }
}

/**
 * Headers for the local request. Host is rewritten to the local target so dev
 * servers that check it (Vite, webpack-dev-server) accept the request; the
 * public host stays available in X-Forwarded-Host.
 */
export function localRequestHeaders(headers: HeaderList, target: LocalTarget): HeaderList {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return [['host', `${host}:${target.port}`], ...stripHopByHop(headers).filter(([name]) => name.toLowerCase() !== 'host')];
}

function flatten(headers: HeaderList): string[] {
  return headers.flat();
}

function pairs(raw: string[]): HeaderList {
  const out: HeaderList = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
}

function describeError(err: Error): string {
  // Connecting to `localhost` tries several addresses and may fail with an
  // AggregateError that has a code but an empty message.
  const code = (err as NodeJS.ErrnoException).code;
  if (!code || err.message.includes(code)) return err.message || 'unknown error';
  return err.message ? `${code}: ${err.message}` : code;
}
