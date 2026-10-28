import { ReceiveWindow, SendWindow, encodeWindow } from './flow.ts';
import { Flags, type Frame, FrameType, MAX_CHUNK_SIZE, ProtocolError } from './frame.ts';
import { decodeRequestHead, type RequestHead } from './messages.ts';

/**
 * WebSocket pass-through. A public `Upgrade: websocket` request becomes a
 * stream that starts with WS_OPEN (a RequestHead, like REQ_HEAD). The client
 * opens a WebSocket to the local server and answers with RES_HEAD:
 *
 * - status 101 and the negotiated `sec-websocket-protocol`, if any: the relay
 *   completes the visitor's upgrade, and from then on both sides exchange
 *   WS_MSG and WS_CLOSE frames on the stream;
 * - any other status: the local server refused the upgrade, and the stream
 *   continues as a normal HTTP response (RES_BODY frames) that the relay
 *   passes on to the visitor.
 *
 * A message travels as one or more WS_MSG fragments, the last one flagged END,
 * with BINARY set on binary messages. Fragments count against the stream's
 * flow-control windows like body bytes do. WS_CLOSE from either side ends the
 * stream: the receiver closes its own WebSocket and expects nothing more.
 * Each hop answers WebSocket pings itself; they don't cross the tunnel.
 */

export const WsFlags = {
  END: Flags.END,
  BINARY: 0x02,
} as const;

/** Largest message passed through. Bigger ones close the WebSocket with 1009. */
export const MAX_WS_MESSAGE = 16 * 1024 * 1024;

export interface WsClose {
  code?: number;
  reason?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeWsOpen(streamId: number, head: RequestHead): Frame {
  return { type: FrameType.WS_OPEN, flags: 0, streamId, payload: encoder.encode(JSON.stringify(head)) };
}

export function decodeWsOpen(frame: Frame): RequestHead {
  if (frame.type !== FrameType.WS_OPEN) {
    throw new ProtocolError(`expected frame 0x${FrameType.WS_OPEN.toString(16)}, got 0x${frame.type.toString(16)}`);
  }
  // Same payload as REQ_HEAD.
  return decodeRequestHead({ ...frame, type: FrameType.REQ_HEAD });
}

export function encodeWsClose(streamId: number, close: WsClose): Frame {
  return { type: FrameType.WS_CLOSE, flags: 0, streamId, payload: encoder.encode(JSON.stringify(close)) };
}

export function decodeWsClose(frame: Frame): WsClose {
  if (frame.type !== FrameType.WS_CLOSE) {
    throw new ProtocolError(`expected frame 0x${FrameType.WS_CLOSE.toString(16)}, got 0x${frame.type.toString(16)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame.payload));
  } catch {
    throw new ProtocolError('WS_CLOSE payload is not valid JSON');
  }
  if (typeof value !== 'object' || value === null) throw new ProtocolError('WS_CLOSE payload is not a JSON object');
  const { code, reason } = value as Record<string, unknown>;
  const close: WsClose = {};
  if (typeof code === 'number' && Number.isInteger(code)) close.code = code;
  if (typeof reason === 'string') close.reason = reason;
  return close;
}

/**
 * Arguments for `WebSocket.close()` that it won't reject: codes like 1005 and
 * 1006 only describe what happened and can't be sent, and reasons are limited
 * to 123 bytes.
 */
export function closeArgs(close: WsClose): [code?: number, reason?: string] {
  const { code } = close;
  if (code === undefined || !((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))) {
    return [];
  }
  let reason = close.reason ?? '';
  while (encoder.encode(reason).byteLength > 123) reason = reason.slice(0, -1);
  return [code, reason];
}

type Outgoing = { kind: 'message'; data: Uint8Array; binary: boolean } | { kind: 'close'; close: WsClose };

/** Queued bytes above which the source socket is asked to pause, and below which it resumes. */
const PAUSE_ABOVE = 1024 * 1024;
const RESUME_BELOW = 256 * 1024;

/**
 * Sends one side's WebSocket messages over a stream as WS_MSG fragments,
 * within the stream's send window, followed by a WS_CLOSE. Messages wait in a
 * queue while there's no credit; when the queue grows large, `backpressure`
 * asks the host to stop reading from its WebSocket for a while.
 */
export class WsSender {
  readonly window = new SendWindow();
  readonly #streamId: number;
  readonly #send: (frame: Frame) => void;
  readonly #backpressure: (paused: boolean) => void;
  #queue: Outgoing[] = [];
  #queuedBytes = 0;
  #paused = false;
  #pumping = false;
  #done = false;

  constructor(streamId: number, send: (frame: Frame) => void, backpressure: (paused: boolean) => void = () => {}) {
    this.#streamId = streamId;
    this.#send = send;
    this.#backpressure = backpressure;
  }

  message(data: string | Uint8Array): void {
    if (this.#done) return;
    const binary = typeof data !== 'string';
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    this.#queue.push({ kind: 'message', data: bytes, binary });
    this.#queuedBytes += bytes.byteLength;
    if (!this.#paused && this.#queuedBytes > PAUSE_ABOVE) {
      this.#paused = true;
      this.#backpressure(true);
    }
    void this.#pump();
  }

  /** Sends WS_CLOSE once every queued message has gone out. */
  close(close: WsClose): void {
    if (this.#done) return;
    this.#queue.push({ kind: 'close', close });
    void this.#pump();
  }

  /** Drops everything still queued; the stream is gone. */
  abort(): void {
    this.#done = true;
    this.#queue = [];
    this.window.close();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.#done) {
        const next = this.#queue[0]!;
        if (next.kind === 'close') {
          this.#send(encodeWsClose(this.#streamId, next.close));
          this.abort();
          return;
        }
        const flags = next.binary ? WsFlags.BINARY : 0;
        const { data } = next;
        if (data.byteLength === 0) {
          this.#send({ type: FrameType.WS_MSG, flags: flags | WsFlags.END, streamId: this.#streamId, payload: data });
        }
        for (let offset = 0; offset < data.byteLength; ) {
          const bytes = await this.window.take(Math.min(MAX_CHUNK_SIZE, data.byteLength - offset));
          if (this.#done || bytes === 0) return;
          const end = offset + bytes === data.byteLength ? WsFlags.END : 0;
          this.#send({
            type: FrameType.WS_MSG,
            flags: flags | end,
            streamId: this.#streamId,
            payload: data.subarray(offset, offset + bytes),
          });
          offset += bytes;
        }
        this.#queue.shift();
        this.#queuedBytes -= data.byteLength;
        if (this.#paused && this.#queuedBytes < RESUME_BELOW) {
          this.#paused = false;
          this.#backpressure(false);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }
}

/**
 * Reassembles WS_MSG fragments into messages. Credit for a message's last
 * fragment goes back only once `deliver` reports the message as sent on, so a
 * slow WebSocket on this side slows the sender down. Earlier fragments are
 * credited as they arrive, so messages larger than the window can complete;
 * MAX_WS_MESSAGE bounds what that can buffer.
 */
export class WsReceiver {
  readonly window = new ReceiveWindow();
  readonly #streamId: number;
  readonly #send: (frame: Frame) => void;
  readonly #deliver: (data: string | Uint8Array, sent: () => void) => void;
  #fragments: Uint8Array[] = [];
  #size = 0;
  #done = false;

  constructor(
    streamId: number,
    send: (frame: Frame) => void,
    deliver: (data: string | Uint8Array, sent: () => void) => void,
  ) {
    this.#streamId = streamId;
    this.#send = send;
    this.#deliver = deliver;
  }

  receive(frame: Frame): void {
    const bytes = frame.payload.byteLength;
    this.window.received(bytes);
    this.#size += bytes;
    if (this.#size > MAX_WS_MESSAGE) throw new ProtocolError(`WebSocket message over ${MAX_WS_MESSAGE} bytes`);
    if (bytes > 0) this.#fragments.push(frame.payload.slice());
    if ((frame.flags & WsFlags.END) === 0) {
      this.#credit(bytes);
      return;
    }

    const message = concat(this.#fragments, this.#size);
    this.#fragments = [];
    this.#size = 0;
    const data = (frame.flags & WsFlags.BINARY) !== 0 ? message : decoder.decode(message);
    this.#deliver(data, () => this.#credit(bytes));
  }

  /** Stops returning credit; the stream is gone. */
  abort(): void {
    this.#done = true;
    this.#fragments = [];
  }

  #credit(bytes: number): void {
    if (this.#done) return;
    const increment = this.window.consumed(bytes);
    if (increment > 0) this.#send(encodeWindow(this.#streamId, increment));
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
