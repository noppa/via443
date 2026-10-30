import { describe, expect, it } from 'vitest';
import {
  closeArgs,
  decodeWsClose,
  decodeWsOpen,
  encodeWsClose,
  encodeWsOpen,
  type Frame,
  MAX_WS_MESSAGE,
  WsFlags,
  WsReceiver,
  WsSender,
  decodeFrame,
  decodeGoAway,
  decodeRequestHead,
  decodeReset,
  decodeResponseHead,
  decodeWelcome,
  decodeWindow,
  encodeBody,
  encodeFrame,
  encodeGoAway,
  encodeRequestHead,
  encodeReset,
  encodeResponseHead,
  encodeWelcome,
  encodeWindow,
  Flags,
  FrameType,
  HEADER_SIZE,
  INITIAL_WINDOW,
  isEnd,
  MAX_STREAM_ID,
  formatResume,
  parseBearer,
  parseResume,
  ProtocolError,
  ReceiveWindow,
  SendWindow,
  stripHopByHop,
} from '../src/index.ts';

const roundTrip = (frame: Parameters<typeof encodeFrame>[0]) => decodeFrame(encodeFrame(frame));

describe('frame codec', () => {
  it('round-trips header fields and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 255]);
    const frame = roundTrip({ type: FrameType.RES_BODY, flags: Flags.END, streamId: 0x01020304, payload });
    expect(frame.type).toBe(FrameType.RES_BODY);
    expect(frame.flags).toBe(Flags.END);
    expect(frame.streamId).toBe(0x01020304);
    expect([...frame.payload]).toEqual([1, 2, 3, 255]);
  });

  it('uses a fixed big-endian 6-byte header', () => {
    const bytes = encodeFrame({ type: FrameType.PING, flags: 0, streamId: 258, payload: new Uint8Array([9]) });
    expect([...bytes]).toEqual([FrameType.PING, 0, 0, 0, 1, 2, 9]);
    expect(HEADER_SIZE).toBe(6);
  });

  it('accepts the full stream id range', () => {
    expect(roundTrip({ type: FrameType.RESET, flags: 0, streamId: MAX_STREAM_ID, payload: new Uint8Array() }).streamId)
      .toBe(MAX_STREAM_ID);
  });

  it('decodes a frame that is a view into a larger buffer', () => {
    const encoded = encodeFrame({ type: FrameType.PONG, flags: 0, streamId: 7, payload: new Uint8Array([42]) });
    const big = new Uint8Array(encoded.byteLength + 10);
    big.set(encoded, 5);
    const frame = decodeFrame(big.subarray(5, 5 + encoded.byteLength));
    expect(frame.streamId).toBe(7);
    expect([...frame.payload]).toEqual([42]);
  });

  it('rejects short frames, unknown types and bad stream ids', () => {
    expect(() => decodeFrame(new Uint8Array([1, 0, 0]))).toThrow(ProtocolError);
    expect(() => decodeFrame(new Uint8Array([0x7f, 0, 0, 0, 0, 0]))).toThrow(/unknown frame type/);
    for (const streamId of [-1, 1.5, MAX_STREAM_ID + 1]) {
      expect(() => encodeFrame({ type: FrameType.PING, flags: 0, streamId, payload: new Uint8Array() })).toThrow(
        ProtocolError,
      );
    }
  });
});

describe('messages', () => {
  it('round-trips WELCOME and GOAWAY on stream 0', () => {
    const welcome = { version: 1, tunnelId: 'abcd1234efgh5678', url: 'https://abcd1234efgh5678.via443.com', resumeToken: 'r' };
    const frame = roundTrip(encodeWelcome(welcome));
    expect(frame.streamId).toBe(0);
    expect(decodeWelcome(frame)).toEqual(welcome);
    const goAway = { code: 'unauthorized', message: 'bad token' };
    expect(decodeGoAway(roundTrip(encodeGoAway(goAway)))).toEqual(goAway);
  });

  it('round-trips request and response heads, keeping repeated headers in order', () => {
    const req = {
      method: 'POST',
      path: '/a?b=c',
      headers: [
        ['content-type', 'text/plain'],
        ['x-dup', '1'],
        ['x-dup', '2'],
      ] as [string, string][],
    };
    const reqFrame = roundTrip(encodeRequestHead(5, req, true));
    expect(reqFrame.streamId).toBe(5);
    expect(isEnd(reqFrame)).toBe(true);
    expect(decodeRequestHead(reqFrame)).toEqual(req);

    const res = { status: 201, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] as [string, string][] };
    const resFrame = roundTrip(encodeResponseHead(5, res, false));
    expect(isEnd(resFrame)).toBe(false);
    expect(decodeResponseHead(resFrame)).toEqual(res);
  });

  it('round-trips RESET with an optional message', () => {
    expect(decodeReset(roundTrip(encodeReset(3, { code: 'cancelled' })))).toEqual({ code: 'cancelled' });
    expect(decodeReset(roundTrip(encodeReset(3, { code: 'upstream_error', message: 'ECONNREFUSED' })))).toEqual({
      code: 'upstream_error',
      message: 'ECONNREFUSED',
    });
  });

  it('encodes body chunks as raw payload', () => {
    const frame = roundTrip(encodeBody(FrameType.REQ_BODY, 9, new Uint8Array([1, 2]), false));
    expect(frame.type).toBe(FrameType.REQ_BODY);
    expect(isEnd(frame)).toBe(false);
    expect([...frame.payload]).toEqual([1, 2]);
    expect(isEnd(encodeBody(FrameType.RES_BODY, 9, new Uint8Array(), true))).toBe(true);
  });

  it('rejects malformed payloads', () => {
    const raw = (type: number, text: string) =>
      decodeFrame(encodeFrame({ type: type as FrameType, flags: 0, streamId: 0, payload: new TextEncoder().encode(text) }));
    expect(() => decodeWelcome(raw(FrameType.WELCOME, 'not json'))).toThrow(/not valid JSON/);
    expect(() => decodeWelcome(raw(FrameType.WELCOME, '[]'))).toThrow(/not a JSON object/);
    expect(() => decodeWelcome(raw(FrameType.WELCOME, '{"version":"1"}'))).toThrow(/version/);
    expect(() => decodeRequestHead(raw(FrameType.REQ_HEAD, '{"method":"GET","path":"/","headers":[["a"]]}'))).toThrow(
      /headers/,
    );
    expect(() => decodeResponseHead(raw(FrameType.RES_HEAD, '{"status":42,"headers":[]}'))).toThrow(/status/);
    expect(() => decodeWelcome(raw(FrameType.GOAWAY, '{}'))).toThrow(/expected frame/);
  });
});

describe('flow control', () => {
  it('round-trips WINDOW increments and rejects bad ones', () => {
    expect(decodeWindow(roundTrip(encodeWindow(5, 128 * 1024)))).toBe(128 * 1024);
    const raw = (streamId: number, payload: number[]) =>
      decodeFrame(encodeFrame({ type: FrameType.WINDOW, flags: 0, streamId, payload: new Uint8Array(payload) }));
    expect(() => decodeWindow(raw(5, [0, 0, 0, 0]))).toThrow(ProtocolError);
    expect(() => decodeWindow(raw(5, [0x80, 0, 0, 0]))).toThrow(ProtocolError);
    expect(() => decodeWindow(raw(5, [0, 1]))).toThrow(/4 bytes/);
    expect(() => decodeWindow(raw(0, [0, 0, 0, 1]))).toThrow(/stream 0/);
    expect(() => encodeWindow(5, 0)).toThrow(ProtocolError);
  });

  it('makes the sender wait for credit and wakes it on grant or close', async () => {
    const window = new SendWindow();
    expect(await window.take(INITIAL_WINDOW + 1)).toBe(INITIAL_WINDOW);

    let taken: number | undefined;
    const pending = window.take(100).then((n) => (taken = n));
    await Promise.resolve();
    expect(taken).toBeUndefined();
    window.grant(40);
    await pending;
    expect(taken).toBe(40);

    const closed = window.take(100);
    window.close();
    expect(await closed).toBe(0);
    expect(() => new SendWindow().grant(0x7fff_ffff)).toThrow(/overflow/);
  });

  it('returns credit in batches and rejects a peer that overruns its window', () => {
    const window = new ReceiveWindow();
    window.received(INITIAL_WINDOW);
    expect(() => window.received(1)).toThrow(/exceeded/);
    expect(window.consumed(INITIAL_WINDOW / 2 - 1)).toBe(0);
    expect(window.consumed(1)).toBe(INITIAL_WINDOW / 2);
    window.received(INITIAL_WINDOW / 2);
    expect(() => window.received(1)).toThrow(/exceeded/);
  });
});

describe('WebSocket pass-through', () => {
  it('round-trips WS_OPEN and WS_CLOSE', () => {
    const head = { method: 'GET', path: '/hmr', headers: [['sec-websocket-protocol', 'vite-hmr']] as [string, string][] };
    expect(decodeWsOpen(roundTrip(encodeWsOpen(3, head)))).toEqual(head);
    expect(decodeWsClose(roundTrip(encodeWsClose(3, { code: 4000, reason: 'bye' })))).toEqual({ code: 4000, reason: 'bye' });
    expect(decodeWsClose(roundTrip(encodeWsClose(3, {})))).toEqual({});
  });

  it('only passes close codes that WebSocket.close() accepts', () => {
    expect(closeArgs({ code: 1000, reason: 'ok' })).toEqual([1000, 'ok']);
    expect(closeArgs({ code: 4999 })).toEqual([4999, '']);
    for (const code of [undefined, 1005, 1006, 1015, 2000, 5000]) expect(closeArgs({ code })).toEqual([]);
    expect(new TextEncoder().encode(closeArgs({ code: 1000, reason: 'é'.repeat(100) })[1]).byteLength).toBeLessThanOrEqual(123);
  });

  /** A sender wired straight into a receiver, as if over the tunnel. */
  function pipe() {
    const delivered: (string | Uint8Array)[] = [];
    const frames: Frame[] = [];
    let release: (() => void)[] = [];
    let hold = false;
    const receiver = new WsReceiver(
      1,
      (frame) => sender.window.grant(decodeWindow(frame)),
      (data, sent) => {
        delivered.push(data);
        if (hold) release.push(sent);
        else sent();
      },
    );
    const pauses: boolean[] = [];
    const sender = new WsSender(
      1,
      (frame) => {
        frames.push(frame);
        if (frame.type === FrameType.WS_MSG) receiver.receive(decodeFrame(encodeFrame(frame)));
      },
      (paused) => pauses.push(paused),
    );
    return {
      sender,
      delivered,
      frames,
      pauses,
      hold: (on: boolean) => {
        hold = on;
        if (!on) for (const sent of release.splice(0)) sent();
      },
    };
  }
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  it('fragments messages and reassembles them, text and binary', async () => {
    const p = pipe();
    const big = new Uint8Array(INITIAL_WINDOW * 3).map((_, i) => i % 7);
    p.sender.message('héllo');
    p.sender.message(big);
    p.sender.message('');
    p.sender.close({ code: 1000 });
    await settle();
    expect(p.delivered).toHaveLength(3);
    expect(p.delivered[0]).toBe('héllo');
    // Compared as bytes: deep equality over millions of elements is very slow.
    expect(Buffer.compare(p.delivered[1] as Uint8Array, big)).toBe(0);
    expect(p.delivered[2]).toBe('');
    expect(p.frames.filter((f) => f.type === FrameType.WS_MSG && (f.flags & WsFlags.END) !== 0)).toHaveLength(3);
    expect(p.frames.every((f) => f.payload.byteLength <= 64 * 1024)).toBe(true);
    expect(p.frames.at(-1)!.type).toBe(FrameType.WS_CLOSE);
  });

  it('holds messages back while the receiving side is slow, and pauses the source', async () => {
    const p = pipe();
    p.hold(true);
    const chunk = new Uint8Array(32 * 1024);
    for (let i = 0; i < 64; i++) p.sender.message(chunk);
    await settle();
    expect(p.delivered.length).toBeLessThan(64);
    expect(p.pauses).toEqual([true]);
    p.hold(false);
    for (let i = 0; i < 20 && p.delivered.length < 64; i++) {
      await settle();
      p.hold(false);
    }
    expect(p.delivered).toHaveLength(64);
    expect(p.pauses).toEqual([true, false]);
  });

  it('rejects oversized messages', () => {
    const receiver = new WsReceiver(1, () => {}, () => {});
    const fragment = (end: boolean) =>
      ({ type: FrameType.WS_MSG, flags: end ? WsFlags.END : 0, streamId: 1, payload: new Uint8Array(64 * 1024) }) as Frame;
    expect(() => {
      for (let i = 0; i <= MAX_WS_MESSAGE / (64 * 1024); i++) receiver.receive(fragment(false));
    }).toThrow(/WebSocket message over/);
  });
});

describe('connect helpers', () => {
  it('formats and parses resume requests', () => {
    const resume = { tunnelId: 'abcd1234efgh5678', resumeToken: 'x:y' };
    expect(parseResume(formatResume(resume))).toEqual(resume);
    for (const bad of [undefined, null, '', 'abc', ':tok', 'abc:']) expect(parseResume(bad)).toBeUndefined();
  });

  it('parses bearer tokens', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer  abc ')).toBe('abc');
    for (const bad of [undefined, null, '', 'Basic abc', 'Bearer', 'Bearer a b']) expect(parseBearer(bad)).toBeUndefined();
  });
});

describe('stripHopByHop', () => {
  it('drops hop-by-hop headers and those named in Connection, case-insensitively', () => {
    expect(
      stripHopByHop([
        ['Content-Type', 'text/html'],
        ['Connection', 'keep-alive, X-Custom'],
        ['Keep-Alive', 'timeout=5'],
        ['Transfer-Encoding', 'chunked'],
        ['x-custom', '1'],
        ['Set-Cookie', 'a=1'],
      ]),
    ).toEqual([
      ['Content-Type', 'text/html'],
      ['Set-Cookie', 'a=1'],
    ]);
  });
});
