import {
  decodeFrame,
  decodeGoAway,
  decodeReset,
  decodeResponseHead,
  encodeBody,
  encodeFrame,
  encodeRequestHead,
  encodeReset,
  encodeWelcome,
  type Frame,
  FrameType,
  type HeaderList,
  isEnd,
  MAX_CHUNK_SIZE,
  ProtocolError,
  type RequestHead,
  stripHopByHop,
  type Welcome,
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

interface Stream {
  respond(response: Response): void;
  /** RES_HEAD arrived and the Response was handed out. */
  responded: boolean;
  /** The response body; absent for responses without one. */
  body?: ReadableStreamDefaultController<Uint8Array>;
  /** Cancels the request body upload, if one is still running. */
  stopUpload?: () => void;
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
  #nextStreamId = 1;
  #closed = false;

  constructor(socket: TunnelSocket) {
    this.#socket = socket;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get activeStreams(): number {
    return this.#streams.size;
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
      const stream: Stream = { respond: resolve, responded: false };
      this.#streams.set(streamId, stream);
      this.#send(encodeRequestHead(streamId, buildRequestHead(req, ctx), !hasBody));
      if (req.body) this.#upload(streamId, stream, req.body);
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
        const detail = reset.message ? `${reset.code}: ${reset.message}` : reset.code;
        this.#fail(frame.streamId, `the tunnel client could not complete the request (${detail}).`);
        return;
      }
      case FrameType.WINDOW:
        // Flow control is not implemented yet.
        return;
      default:
        throw new ProtocolError(`unexpected frame 0x${frame.type.toString(16)} from client`);
    }
  }

  #onResponseHead(frame: Frame): void {
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return; // Already cancelled on our side.
    if (stream.responded) throw new ProtocolError(`duplicate RES_HEAD on stream ${frame.streamId}`);
    const head = decodeResponseHead(frame);

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

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream.body = controller;
      },
      cancel: () => this.#cancel(frame.streamId, 'cancelled', 'response body cancelled'),
    });
    stream.respond(new Response(body, { status: head.status, headers }));
  }

  #onResponseBody(frame: Frame): void {
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return;
    if (!stream.responded) throw new ProtocolError(`RES_BODY before RES_HEAD on stream ${frame.streamId}`);
    if (stream.body) {
      if (frame.payload.byteLength > 0) stream.body.enqueue(frame.payload.slice());
      if (isEnd(frame)) stream.body.close();
    }
    if (isEnd(frame)) this.#finish(frame.streamId);
  }

  #upload(streamId: number, stream: Stream, body: ReadableStream<Uint8Array>): void {
    const reader = body.getReader();
    let stopped = false;
    stream.stopUpload = () => {
      stopped = true;
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
          for (let offset = 0; offset < value.byteLength; offset += MAX_CHUNK_SIZE) {
            this.#send(encodeBody(FrameType.REQ_BODY, streamId, value.subarray(offset, offset + MAX_CHUNK_SIZE), false));
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
    } else if (stream.body) {
      try {
        stream.body.error(new Error(message));
      } catch {
        // Already closed or errored.
      }
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
