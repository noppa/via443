import http from 'node:http';
import {
  decodeRequestHead,
  decodeReset,
  encodeBody,
  encodeReset,
  encodeResponseHead,
  type Frame,
  FrameType,
  type HeaderList,
  isEnd,
  MAX_CHUNK_SIZE,
  type RequestHead,
  stripHopByHop,
} from '@via443/protocol';

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
}

const NO_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Replays requests that arrive over the tunnel against the local server and
 * streams the responses back as frames.
 */
export class LocalForwarder {
  readonly #streams = new Map<number, LocalStream>();
  readonly #target: LocalTarget;
  readonly #send: (frame: Frame) => void;
  readonly #onRequest: (entry: RequestLogEntry) => void;

  constructor(target: LocalTarget, send: (frame: Frame) => void, onRequest: (entry: RequestLogEntry) => void = () => {}) {
    this.#target = target;
    this.#send = send;
    this.#onRequest = onRequest;
  }

  get activeStreams(): number {
    return this.#streams.size;
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
        if (frame.payload.byteLength > 0) stream.request.write(frame.payload);
        if (isEnd(frame)) stream.request.end();
        return;
      }
      case FrameType.RESET: {
        decodeReset(frame);
        this.#abort(frame.streamId);
        return;
      }
    }
  }

  /** Drops every open stream, e.g. because the tunnel connection was lost. */
  abortAll(): void {
    for (const streamId of [...this.#streams.keys()]) this.#abort(streamId);
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
    const stream: LocalStream = { request, done: false };
    this.#streams.set(streamId, stream);

    request.on('response', (response) => {
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
      response.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK_SIZE) {
          this.#send(encodeBody(FrameType.RES_BODY, streamId, chunk.subarray(offset, offset + MAX_CHUNK_SIZE), false));
        }
      });
      response.on('end', () => {
        if (stream.done) return;
        this.#send(encodeBody(FrameType.RES_BODY, streamId, new Uint8Array(), true));
        this.#complete(streamId);
        log(response.statusCode);
      });
      response.on('error', (err) => this.#fail(streamId, err, () => log(response.statusCode, err.message)));
    });

    request.on('error', (err) => this.#fail(streamId, err, () => log(undefined, describeError(err))));
    if (end) request.end();
  }

  #fail(streamId: number, err: Error, log: () => void): void {
    const stream = this.#streams.get(streamId);
    if (!stream || stream.done) return;
    this.#send(encodeReset(streamId, { code: 'upstream_error', message: describeError(err) }));
    this.#complete(streamId);
    log();
  }

  #abort(streamId: number): void {
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
