import { Flags, type Frame, FrameType, ProtocolError } from './frame.ts';

export const PROTOCOL_VERSION = 1;

/** Header list that keeps order and repeated names (e.g. Set-Cookie). */
export type HeaderList = [name: string, value: string][];

/** Client → relay, first frame on a new connection. */
export interface Hello {
  version: number;
  /** API token of the user opening the tunnel. */
  token: string;
  /** Present when reconnecting: asks for the same tunnel ID back. */
  resume?: { tunnelId: string; resumeToken: string };
}

/** Relay → client, reply to an accepted HELLO. */
export interface Welcome {
  version: number;
  tunnelId: string;
  url: string;
  /** Secret the client presents to get the same tunnel ID after a reconnect. */
  resumeToken: string;
}

/** Either side: the connection is closing, and why. */
export interface GoAway {
  code: string;
  message: string;
}

/** Relay → client: start of a public request. */
export interface RequestHead {
  method: string;
  /** Path and query, e.g. `/api/items?page=2`. */
  path: string;
  headers: HeaderList;
}

/** Client → relay: start of the local server's response. */
export interface ResponseHead {
  status: number;
  headers: HeaderList;
}

/** Either side: abort a stream. */
export interface Reset {
  code: string;
  message?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonFrame(type: FrameType, streamId: number, value: unknown, flags: number = Flags.NONE): Frame {
  return { type, flags, streamId, payload: encoder.encode(JSON.stringify(value)) };
}

function parseJson(frame: Frame): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame.payload));
  } catch {
    throw new ProtocolError(`frame 0x${frame.type.toString(16)}: payload is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`frame 0x${frame.type.toString(16)}: payload is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function expectType(frame: Frame, type: FrameType): void {
  if (frame.type !== type) {
    throw new ProtocolError(`expected frame 0x${type.toString(16)}, got 0x${frame.type.toString(16)}`);
  }
}

function str(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new ProtocolError(`field "${key}" must be a string`);
  return value;
}

function int(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`field "${key}" must be an integer`);
  }
  return value;
}

function headerList(obj: Record<string, unknown>, key: string): HeaderList {
  const value = obj[key];
  if (
    !Array.isArray(value) ||
    !value.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    )
  ) {
    throw new ProtocolError(`field "${key}" must be a list of [name, value] string pairs`);
  }
  return value as HeaderList;
}

export function encodeHello(hello: Hello): Frame {
  return jsonFrame(FrameType.HELLO, 0, hello);
}

export function decodeHello(frame: Frame): Hello {
  expectType(frame, FrameType.HELLO);
  const obj = parseJson(frame);
  const hello: Hello = { version: int(obj, 'version'), token: str(obj, 'token') };
  if (obj.resume !== undefined) {
    if (typeof obj.resume !== 'object' || obj.resume === null) {
      throw new ProtocolError('field "resume" must be an object');
    }
    const resume = obj.resume as Record<string, unknown>;
    hello.resume = { tunnelId: str(resume, 'tunnelId'), resumeToken: str(resume, 'resumeToken') };
  }
  return hello;
}

export function encodeWelcome(welcome: Welcome): Frame {
  return jsonFrame(FrameType.WELCOME, 0, welcome);
}

export function decodeWelcome(frame: Frame): Welcome {
  expectType(frame, FrameType.WELCOME);
  const obj = parseJson(frame);
  return {
    version: int(obj, 'version'),
    tunnelId: str(obj, 'tunnelId'),
    url: str(obj, 'url'),
    resumeToken: str(obj, 'resumeToken'),
  };
}

export function encodeGoAway(goAway: GoAway): Frame {
  return jsonFrame(FrameType.GOAWAY, 0, goAway);
}

export function decodeGoAway(frame: Frame): GoAway {
  expectType(frame, FrameType.GOAWAY);
  const obj = parseJson(frame);
  return { code: str(obj, 'code'), message: str(obj, 'message') };
}

export function encodeRequestHead(streamId: number, head: RequestHead, end: boolean): Frame {
  return jsonFrame(FrameType.REQ_HEAD, streamId, head, end ? Flags.END : Flags.NONE);
}

export function decodeRequestHead(frame: Frame): RequestHead {
  expectType(frame, FrameType.REQ_HEAD);
  const obj = parseJson(frame);
  return { method: str(obj, 'method'), path: str(obj, 'path'), headers: headerList(obj, 'headers') };
}

export function encodeResponseHead(streamId: number, head: ResponseHead, end: boolean): Frame {
  return jsonFrame(FrameType.RES_HEAD, streamId, head, end ? Flags.END : Flags.NONE);
}

export function decodeResponseHead(frame: Frame): ResponseHead {
  expectType(frame, FrameType.RES_HEAD);
  const obj = parseJson(frame);
  const status = int(obj, 'status');
  if (status < 100 || status > 999) throw new ProtocolError(`invalid status ${status}`);
  return { status, headers: headerList(obj, 'headers') };
}

export function encodeReset(streamId: number, reset: Reset): Frame {
  return jsonFrame(FrameType.RESET, streamId, reset);
}

export function decodeReset(frame: Frame): Reset {
  expectType(frame, FrameType.RESET);
  const obj = parseJson(frame);
  const reset: Reset = { code: str(obj, 'code') };
  if (typeof obj.message === 'string') reset.message = obj.message;
  return reset;
}

/** A body chunk; `type` is REQ_BODY or RES_BODY. An empty chunk with END just closes the body. */
export function encodeBody(
  type: typeof FrameType.REQ_BODY | typeof FrameType.RES_BODY,
  streamId: number,
  chunk: Uint8Array,
  end: boolean,
): Frame {
  return { type, flags: end ? Flags.END : Flags.NONE, streamId, payload: chunk };
}

export function isEnd(frame: Frame): boolean {
  return (frame.flags & Flags.END) !== 0;
}
