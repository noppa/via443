import {
  closeArgs,
  decodeFrame,
  decodeGoAway,
  decodeReset,
  decodeResponseHead,
  decodeWindow,
  decodeWsClose,
  encodeBody,
  encodeFrame,
  encodeRequestHead,
  encodeReset,
  encodeWelcome,
  encodeWindow,
  encodeWsOpen,
  type Frame,
  FrameType,
  type HeaderList,
  isEnd,
  MAX_CHUNK_SIZE,
  ProtocolError,
  ReceiveWindow,
  type RequestHead,
  SendWindow,
  stripHopByHop,
  type Welcome,
  type WsClose,
  WsReceiver,
  WsSender,
} from '@via443/protocol';
import { tunnelErrorResponse } from './responses.ts';

/** The relay's end of a client WebSocket, as provided by the host runtime. */
export interface TunnelSocket {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface ForwardContext {
  /** Address of the public visitor, for X-Forwarded-For. */
  clientIp?: string;
  /** Scheme of the public URL, for X-Forwarded-Proto. */
  proto: 'http' | 'https';
}

/** The relay's end of a visitor's WebSocket, as provided by the host runtime. */
export interface VisitorSocket {
  /** Sends a message and calls `sent` once it's handed off; that returns credit to the client. */
  send(data: string | Uint8Array, sent: () => void): void;
  close(code?: number, reason?: string): void;
  /** Stop and restart reading the visitor's messages, if the runtime can. */
  pause?(): void;
  resume?(): void;
}

interface Stream {
  respond(response: Response): void;
  /** Set for WebSocket streams: the local server accepted the upgrade. */
  upgrade?: (ws: TunnelWebSocket) => void;
  /** RES_HEAD arrived and the Response was handed out. */
  responded: boolean;
  /** The response body; absent for responses without one. */
  body?: InboundBody;
  /** Cancels the request body upload, if one is still running. */
  stopUpload?: () => void;
  /** Credit for sending the request body. */
  uploadWindow: SendWindow;
  /** Credit the client has for sending the response body. */
  downloadWindow: ReceiveWindow;
}

/** Statuses whose responses never have a body; the Response constructor rejects one. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** WebSocket close code for protocol violations. */
const CLOSE_PROTOCOL_ERROR = 1002;

/**
 * One connected tunnel client. Turns public requests into frames on the
 * client's WebSocket and the client's frames back into responses.
 *
 * The host runtime feeds it incoming messages with `receive()` and tells it
 * when the socket is gone with `closed()`.
 */
export class TunnelSession {
  readonly #socket: TunnelSocket;
  readonly #streams = new Map<number, Stream>();
  readonly #webSockets = new Map<number, TunnelWebSocket>();
  #nextStreamId = 1;
  #closed = false;

  constructor(socket: TunnelSocket) {
    this.#socket = socket;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get activeStreams(): number {
    return this.#streams.size + this.#webSockets.size;
  }

  welcome(welcome: Welcome): void {
    this.#send(encodeWelcome(welcome));
  }

  /** Forwards a public request through the tunnel. Never rejects: failures become error responses. */
  handleRequest(req: Request, ctx: ForwardContext): Promise<Response> {
    if (this.#closed) return Promise.resolve(tunnelErrorResponse(502, 'the tunnel client is not connected.'));

    const streamId = this.#nextStreamId++;
    const hasBody = req.body !== null;

    return new Promise<Response>((resolve) => {
      const stream: Stream = {
        respond: resolve,
        responded: false,
        uploadWindow: new SendWindow(),
        downloadWindow: new ReceiveWindow(),
      };
      this.#streams.set(streamId, stream);
      this.#send(encodeRequestHead(streamId, buildRequestHead(req, ctx), !hasBody));
      if (req.body) this.#upload(streamId, stream, req.body);
      req.signal?.addEventListener('abort', () => this.#cancel(streamId, 'cancelled', 'request aborted'), {
        once: true,
      });
    });
  }

  /**
   * Forwards a public WebSocket upgrade request. Resolves to a TunnelWebSocket
   * once the local server has accepted it: the host then completes the
   * visitor's upgrade and calls `attach()`. Otherwise resolves to the response
   * to send the visitor instead, e.g. the local server's 404 or a 502.
   */
  openWebSocket(req: Request, ctx: ForwardContext): Promise<TunnelWebSocket | Response> {
    if (this.#closed) return Promise.resolve(tunnelErrorResponse(502, 'the tunnel client is not connected.'));

    const streamId = this.#nextStreamId++;
    return new Promise<TunnelWebSocket | Response>((resolve) => {
      const stream: Stream = {
        respond: resolve,
        upgrade: resolve,
        responded: false,
        uploadWindow: new SendWindow(),
        downloadWindow: new ReceiveWindow(),
      };
      this.#streams.set(streamId, stream);
      this.#send(encodeWsOpen(streamId, buildRequestHead(req, ctx)));
      req.signal?.addEventListener('abort', () => this.#cancel(streamId, 'cancelled', 'request aborted'), {
        once: true,
      });
    });
  }

  /** Handles one binary message from the client. */
  receive(data: Uint8Array): void {
    if (this.#closed) return;
    let frame: Frame;
    try {
      frame = decodeFrame(data);
      this.#dispatch(frame);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.close(CLOSE_PROTOCOL_ERROR, err.message);
    }
  }

  /** Closes the socket and fails every open stream. */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#socket.close(code, reason);
    this.closed();
  }

  /** Called by the host runtime when the socket has closed. */
  closed(): void {
    if (this.#closed && this.#streams.size === 0) return;
    this.#closed = true;
    for (const streamId of [...this.#streams.keys()]) {
      this.#fail(streamId, 'the tunnel client disconnected.');
    }
    for (const ws of [...this.#webSockets.values()]) ws.handle({ kind: 'gone' });
  }

  #dispatch(frame: Frame): void {
    switch (frame.type) {
      case FrameType.PING:
        this.#send({ type: FrameType.PONG, flags: 0, streamId: 0, payload: frame.payload });
        return;
      case FrameType.PONG:
        return;
      case FrameType.GOAWAY: {
        const goAway = decodeGoAway(frame);
        this.close(1000, goAway.code);
        return;
      }
      case FrameType.RES_HEAD:
        this.#onResponseHead(frame);
        return;
      case FrameType.RES_BODY:
        this.#onResponseBody(frame);
        return;
      case FrameType.RESET: {
        const reset = decodeReset(frame);
        const ws = this.#webSockets.get(frame.streamId);
        if (ws) {
          ws.handle({ kind: 'reset' });
          return;
        }
        const detail = reset.message ? `${reset.code}: ${reset.message}` : reset.code;
        this.#fail(frame.streamId, `the tunnel client could not complete the request (${detail}).`);
        return;
      }
      case FrameType.WINDOW: {
        const increment = decodeWindow(frame);
        this.#streams.get(frame.streamId)?.uploadWindow.grant(increment);
        this.#webSockets.get(frame.streamId)?.handle({ kind: 'window', increment });
        return;
      }
      case FrameType.WS_MSG:
      case FrameType.WS_CLOSE: {
        const ws = this.#webSockets.get(frame.streamId);
        if (ws) {
          ws.handle(frame.type === FrameType.WS_MSG ? { kind: 'message', frame } : { kind: 'close', close: decodeWsClose(frame) });
        } else if (this.#streams.has(frame.streamId)) {
          throw new ProtocolError(`WebSocket frame before the upgrade on stream ${frame.streamId}`);
        }
        return;
      }
      default:
        throw new ProtocolError(`unexpected frame 0x${frame.type.toString(16)} from client`);
    }
  }

  #onResponseHead(frame: Frame): void {
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return; // Already cancelled on our side.
    if (stream.responded) throw new ProtocolError(`duplicate RES_HEAD on stream ${frame.streamId}`);
    const head = decodeResponseHead(frame);

    if (head.status === 101 && stream.upgrade) {
      const streamId = frame.streamId;
      this.#streams.delete(streamId);
      const protocol = head.headers.find(([name]) => name.toLowerCase() === 'sec-websocket-protocol')?.[1];
      const ws = new TunnelWebSocket(streamId, protocol, (f) => this.#send(f), () => this.#webSockets.delete(streamId));
      this.#webSockets.set(streamId, ws);
      stream.upgrade(ws);
      return;
    }

    if (head.status < 200 || head.status > 599) {
      this.#cancel(frame.streamId, 'bad_status', `status ${head.status} is not supported`);
      stream.respond(tunnelErrorResponse(502, `the local server sent unsupported status ${head.status}.`));
      return;
    }

    const headers = new Headers();
    for (const [name, value] of stripHopByHop(head.headers)) headers.append(name, value);

    stream.responded = true;
    if (isEnd(frame) || NULL_BODY_STATUSES.has(head.status)) {
      // Without END, keep the stream so that body frames still in flight are dropped quietly.
      if (isEnd(frame)) this.#finish(frame.streamId);
      stream.respond(new Response(null, { status: head.status, headers }));
      return;
    }

    const streamId = frame.streamId;
    stream.body = new InboundBody(
      (bytes) => {
        const increment = stream.downloadWindow.consumed(bytes);
        if (increment > 0 && this.#streams.has(streamId)) this.#send(encodeWindow(streamId, increment));
      },
      () => this.#cancel(streamId, 'cancelled', 'response body cancelled'),
    );
    stream.respond(new Response(stream.body.readable, { status: head.status, headers }));
  }

  #onResponseBody(frame: Frame): void {
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return;
    if (!stream.responded) throw new ProtocolError(`RES_BODY before RES_HEAD on stream ${frame.streamId}`);
    stream.downloadWindow.received(frame.payload.byteLength);
    if (stream.body) {
      if (frame.payload.byteLength > 0) stream.body.push(frame.payload.slice());
      if (isEnd(frame)) stream.body.end();
    }
    if (isEnd(frame)) this.#finish(frame.streamId);
  }

  #upload(streamId: number, stream: Stream, body: ReadableStream<Uint8Array>): void {
    const reader = body.getReader();
    let stopped = false;
    stream.stopUpload = () => {
      stopped = true;
      stream.uploadWindow.close();
      reader.cancel().catch(() => {});
    };
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) {
            this.#send(encodeBody(FrameType.REQ_BODY, streamId, new Uint8Array(), true));
            return;
          }
          for (let offset = 0; offset < value.byteLength; ) {
            const bytes = await stream.uploadWindow.take(Math.min(MAX_CHUNK_SIZE, value.byteLength - offset));
            if (stopped || bytes === 0) return;
            this.#send(encodeBody(FrameType.REQ_BODY, streamId, value.subarray(offset, offset + bytes), false));
            offset += bytes;
          }
        }
      } catch {
        if (!stopped) this.#cancel(streamId, 'cancelled', 'request body upload failed');
      } finally {
        stream.stopUpload = undefined;
      }
    };
    void pump();
  }

  /** Our side gives up on a stream: tell the client and fail it locally. */
  #cancel(streamId: number, code: string, message: string): void {
    if (!this.#streams.has(streamId)) return;
    if (!this.#closed) this.#send(encodeReset(streamId, { code, message }));
    this.#fail(streamId, message);
  }

  /** Ends a stream with an error: a 502 if no response started yet, otherwise a broken body. */
  #fail(streamId: number, message: string): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#streams.delete(streamId);
    stream.stopUpload?.();
    if (!stream.responded) {
      stream.respond(tunnelErrorResponse(502, message));
    } else {
      stream.body?.error(new Error(message));
    }
  }

  /** The response is complete; any request body still uploading is no longer needed. */
  #finish(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#streams.delete(streamId);
    stream.stopUpload?.();
  }

  #send(frame: Frame): void {
    if (this.#closed) return;
    this.#socket.send(encodeFrame(frame));
  }
}

/** What the tunnel side tells a TunnelWebSocket. */
type TunnelEvent =
  | { kind: 'message'; frame: Frame }
  | { kind: 'close'; close: WsClose }
  | { kind: 'window'; increment: number }
  | { kind: 'reset' }
  | { kind: 'gone' };

/**
 * A visitor's WebSocket, passed through the tunnel to the local server. The
 * host completes the visitor's upgrade offering `protocol`, then calls
 * `attach()` with the socket and reports the visitor's messages with
 * `message()` and the end of the socket with `closed()`. If the upgrade fails,
 * the host calls `closed()` without attaching.
 */
export class TunnelWebSocket {
  /** Subprotocol the local server picked, for the visitor's 101 response. */
  readonly protocol: string | undefined;
  readonly #sender: WsSender;
  readonly #receiver: WsReceiver;
  readonly #onDone: () => void;
  #socket: VisitorSocket | undefined;
  /** Calls waiting for the visitor socket: the client may talk before the visitor's upgrade completes. */
  #pending: ((socket: VisitorSocket) => void)[] = [];
  #done = false;

  /** @internal Created by TunnelSession. */
  constructor(streamId: number, protocol: string | undefined, send: (frame: Frame) => void, onDone: () => void) {
    this.protocol = protocol;
    this.#onDone = onDone;
    this.#sender = new WsSender(
      streamId,
      (frame) => {
        send(frame);
        if (frame.type === FrameType.WS_CLOSE) this.#finish();
      },
      (paused) => (paused ? this.#socket?.pause?.() : this.#socket?.resume?.()),
    );
    this.#receiver = new WsReceiver(streamId, send, (data, sent) =>
      this.#withSocket((socket) => socket.send(data, sent)),
    );
  }

  attach(socket: VisitorSocket): void {
    this.#socket = socket;
    for (const call of this.#pending.splice(0)) call(socket);
  }

  /** The visitor sent a message. */
  message(data: string | Uint8Array): void {
    this.#sender.message(data);
  }

  /** The visitor's socket closed, or the upgrade failed. */
  closed(code?: number, reason?: string): void {
    if (this.#done) return;
    // Nothing more goes to the visitor, but its last messages still go out before WS_CLOSE.
    this.#receiver.abort();
    this.#sender.close({ code, reason });
  }

  /** @internal Called by TunnelSession. */
  handle(event: TunnelEvent): void {
    if (this.#done) return;
    switch (event.kind) {
      case 'message':
        this.#receiver.receive(event.frame);
        return;
      case 'window':
        this.#sender.window.grant(event.increment);
        return;
      case 'close': {
        const [code, reason] = closeArgs(event.close);
        this.#withSocket((socket) => socket.close(code, reason));
        break;
      }
      case 'reset':
        this.#withSocket((socket) => socket.close(1011, 'the tunnel client reset the connection'));
        break;
      case 'gone':
        this.#withSocket((socket) => socket.close(1001, 'the tunnel client disconnected'));
        break;
    }
    this.#finish();
  }

  #withSocket(call: (socket: VisitorSocket) => void): void {
    if (this.#socket) call(this.#socket);
    else this.#pending.push(call);
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#sender.abort();
    this.#receiver.abort();
    this.#onDone();
  }
}

/**
 * A response body fed by RES_BODY frames. Chunks wait here until the visitor
 * side reads them, and only then does the client get its credit back, so a
 * slow visitor slows the local server down instead of filling the relay's memory.
 */
class InboundBody {
  readonly readable: ReadableStream<Uint8Array>;
  #queue: Uint8Array[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;

  constructor(onConsumed: (bytes: number) => void, onCancel: () => void) {
    this.readable = new ReadableStream<Uint8Array>(
      {
        // With a high-water mark of 0, pull runs only when someone is waiting to read.
        pull: async (controller) => {
          while (this.#queue.length === 0 && !this.#ended && !this.#error) {
            await new Promise<void>((resolve) => (this.#wake = resolve));
          }
          if (this.#error) {
            controller.error(this.#error);
            return;
          }
          const chunk = this.#queue.shift();
          if (!chunk) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          onConsumed(chunk.byteLength);
        },
        cancel: onCancel,
      },
      { highWaterMark: 0 },
    );
  }

  push(chunk: Uint8Array): void {
    this.#queue.push(chunk);
    this.#signal();
  }

  end(): void {
    this.#ended = true;
    this.#signal();
  }

  /** Fails the body; chunks not read yet are dropped. */
  error(err: Error): void {
    this.#error ??= err;
    this.#queue = [];
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

/** Builds the head sent to the client: hop-by-hop headers removed, X-Forwarded-* set by the relay. */
export function buildRequestHead(req: Request, ctx: ForwardContext): RequestHead {
  const url = new URL(req.url);
  const headers: HeaderList = [];
  for (const [name, value] of req.headers) {
    // Visitors can't set these; the relay is the edge and states them itself.
    if (name.startsWith('x-forwarded-') || name === 'forwarded') continue;
    headers.push([name, value]);
  }
  const forwarded: HeaderList = [
    ['x-forwarded-host', url.host],
    ['x-forwarded-proto', ctx.proto],
  ];
  if (ctx.clientIp) forwarded.push(['x-forwarded-for', ctx.clientIp]);
  return { method: req.method, path: url.pathname + url.search, headers: [...stripHopByHop(headers), ...forwarded] };
}
