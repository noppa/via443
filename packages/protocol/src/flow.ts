import { type Frame, FrameType, ProtocolError } from './frame.ts';

/**
 * Credit-based flow control for body bytes, per stream, in the spirit of HTTP/2.
 *
 * Each direction of a stream starts with INITIAL_WINDOW bytes of credit: the
 * sender may have that many body bytes in flight that the receiver hasn't
 * consumed yet. As the receiver's consumer takes data (the visitor reads the
 * response, the local server accepts the request body), the receiver hands
 * credit back with WINDOW frames. Only body payload bytes count; heads, RESET
 * and an empty END frame don't. Sending more than the credit allows is a
 * protocol error.
 *
 * WINDOW payload: a 4-byte big-endian increment, 1..MAX_WINDOW.
 */

export const INITIAL_WINDOW = 256 * 1024;
export const MAX_WINDOW = 0x7fff_ffff;

/** The receiver returns credit in batches of at least this many bytes, to keep WINDOW frames rare. */
const WINDOW_UPDATE_THRESHOLD = INITIAL_WINDOW / 2;

export function encodeWindow(streamId: number, increment: number): Frame {
  if (streamId === 0) throw new ProtocolError('WINDOW on stream 0');
  if (!Number.isInteger(increment) || increment < 1 || increment > MAX_WINDOW) {
    throw new ProtocolError(`invalid window increment ${increment}`);
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment);
  return { type: FrameType.WINDOW, flags: 0, streamId, payload };
}

export function decodeWindow(frame: Frame): number {
  if (frame.type !== FrameType.WINDOW) {
    throw new ProtocolError(`expected frame 0x${FrameType.WINDOW.toString(16)}, got 0x${frame.type.toString(16)}`);
  }
  if (frame.streamId === 0) throw new ProtocolError('WINDOW on stream 0');
  if (frame.payload.byteLength !== 4) throw new ProtocolError(`WINDOW payload must be 4 bytes, got ${frame.payload.byteLength}`);
  const increment = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0);
  if (increment < 1 || increment > MAX_WINDOW) throw new ProtocolError(`invalid window increment ${increment}`);
  return increment;
}

/** The sending side of one stream direction: how many body bytes we may still send. */
export class SendWindow {
  #credit = INITIAL_WINDOW;
  #closed = false;
  #waiters: (() => void)[] = [];

  get available(): number {
    return this.#credit;
  }

  /**
   * Takes up to `max` bytes of credit, waiting until there is some. Resolves
   * 0 once the window is closed, which means the stream is gone: stop sending.
   */
  async take(max: number): Promise<number> {
    while (this.#credit === 0 && !this.#closed) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#closed) return 0;
    const bytes = Math.min(max, this.#credit);
    this.#credit -= bytes;
    return bytes;
  }

  /** Adds credit from a WINDOW frame. */
  grant(increment: number): void {
    if (this.#credit + increment > MAX_WINDOW) throw new ProtocolError('flow control window overflow');
    this.#credit += increment;
    this.#wake();
  }

  /** Wakes a pending `take()`, which resolves 0. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

/** The receiving side of one stream direction: checks the peer's sends and decides when to return credit. */
export class ReceiveWindow {
  /** Bytes the peer may still send. */
  #credit = INITIAL_WINDOW;
  /** Bytes consumed locally whose credit hasn't been returned yet. */
  #unreturned = 0;

  /** Records body bytes that arrived. Throws if the peer sent more than its credit. */
  received(bytes: number): void {
    if (bytes > this.#credit) throw new ProtocolError('flow control window exceeded');
    this.#credit -= bytes;
  }

  /** Records body bytes our consumer took. Returns the WINDOW increment to send now, or 0. */
  consumed(bytes: number): number {
    this.#unreturned += bytes;
    if (this.#unreturned < WINDOW_UPDATE_THRESHOLD) return 0;
    const increment = this.#unreturned;
    this.#unreturned = 0;
    this.#credit += increment;
    return increment;
  }
}
