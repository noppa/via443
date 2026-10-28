/**
 * Binary frame layout (big-endian), one frame per WebSocket binary message:
 *
 *   0       1       2               6
 *   +-------+-------+---------------+--------------...
 *   | type  | flags |   streamId    |   payload
 *   +-------+-------+---------------+--------------...
 *
 * Stream 0 carries connection-level frames (WELCOME, GOAWAY, PING, PONG).
 * Body frames are flow-controlled per stream with WINDOW frames (see flow.ts).
 * The protocol version, API token and resume request travel as headers on the
 * WebSocket upgrade request (see connect.ts), not as frames, so a relay can
 * route and reject a connection before accepting the WebSocket.
 */

export const FrameType = {
  // Connection level, stream 0.
  WELCOME: 0x01,
  GOAWAY: 0x02,
  PING: 0x03,
  PONG: 0x04,
  // Per stream.
  REQ_HEAD: 0x10,
  REQ_BODY: 0x11,
  RES_HEAD: 0x12,
  RES_BODY: 0x13,
  RESET: 0x14,
  WINDOW: 0x15,
  // WebSocket pass-through, see websocket.ts.
  WS_OPEN: 0x20,
  WS_MSG: 0x21,
  WS_CLOSE: 0x22,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const knownTypes = new Set<number>(Object.values(FrameType));

export const Flags = {
  NONE: 0,
  /** Last frame of a body; the sender won't send more body frames on this stream. */
  END: 0x01,
} as const;

export const HEADER_SIZE = 6;
export const MAX_STREAM_ID = 0xffff_ffff;

/** Bodies are split into chunks of at most this many bytes. */
export const MAX_CHUNK_SIZE = 64 * 1024;

export interface Frame {
  type: FrameType;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}

export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > MAX_STREAM_ID) {
    throw new ProtocolError(`invalid stream id ${frame.streamId}`);
  }
  const out = new Uint8Array(HEADER_SIZE + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.type);
  view.setUint8(1, frame.flags);
  view.setUint32(2, frame.streamId);
  out.set(frame.payload, HEADER_SIZE);
  return out;
}

export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < HEADER_SIZE) {
    throw new ProtocolError(`frame too short: ${data.byteLength} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  if (!knownTypes.has(type)) {
    throw new ProtocolError(`unknown frame type 0x${type.toString(16)}`);
  }
  return {
    type: type as FrameType,
    flags: view.getUint8(1),
    streamId: view.getUint32(2),
    payload: data.subarray(HEADER_SIZE),
  };
}
