import {
  ConnectHeader,
  decodeFrame,
  decodeRequestHead,
  decodeReset,
  decodeWindow,
  decodeWsClose,
  decodeWsOpen,
  encodeBody,
  encodeFrame,
  encodeReset,
  encodeResponseHead,
  encodeWindow,
  encodeWsClose,
  type Frame,
  FrameType,
  INITIAL_WINDOW,
  isEnd,
  PROTOCOL_VERSION,
  WsFlags,
} from '@via443/protocol';
import { describe, expect, it } from 'vitest';
import {
  generateResumeToken,
  generateTunnelId,
  isTunnelId,
  matchHost,
  parseConnectRequest,
  TunnelSession,
  TunnelWebSocket,
  type VisitorSocket,
} from '../src/index.ts';

class FakeSocket {
  sent: Frame[] = [];
  closedWith: [number, string] | undefined;
  send(data: Uint8Array) {
    this.sent.push(decodeFrame(data));
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
}

function setup() {
  const socket = new FakeSocket();
  const session = new TunnelSession(socket);
  const reply = (frame: Frame) => session.receive(encodeFrame(frame));
  return { socket, session, reply };
}

const ctx = { proto: 'https' as const, clientIp: '203.0.113.7' };
const text = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TunnelSession', () => {
  it('forwards a GET and streams the response back', async () => {
    const s = setup();
    const pending = s.session.handleRequest(
      new Request('https://abcd1234.via443.com/path?q=1', {
        headers: { connection: 'x-drop', 'x-drop': '1', 'x-forwarded-for': '6.6.6.6', accept: 'text/plain' },
      }),
      ctx,
    );

    expect(s.socket.sent).toHaveLength(1);
    const head = s.socket.sent[0]!;
    expect(head.type).toBe(FrameType.REQ_HEAD);
    expect(isEnd(head)).toBe(true);
    const req = decodeRequestHead(head);
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/path?q=1');
    expect(req.headers).toContainEqual(['accept', 'text/plain']);
    expect(req.headers).toContainEqual(['x-forwarded-for', '203.0.113.7']);
    expect(req.headers).toContainEqual(['x-forwarded-host', 'abcd1234.via443.com']);
    expect(req.headers).toContainEqual(['x-forwarded-proto', 'https']);
    expect(req.headers.map(([n]) => n)).not.toContain('x-drop');
    expect(req.headers.map(([n]) => n)).not.toContain('connection');
    expect(req.headers).not.toContainEqual(['x-forwarded-for', '6.6.6.6']);

    s.reply(
      encodeResponseHead(
        head.streamId,
        {
          status: 200,
          headers: [
            ['content-type', 'text/plain'],
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
            ['transfer-encoding', 'chunked'],
          ],
        },
        false,
      ),
    );
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(res.headers.get('transfer-encoding')).toBeNull();

    s.reply(encodeBody(FrameType.RES_BODY, head.streamId, text('hello '), false));
    s.reply(encodeBody(FrameType.RES_BODY, head.streamId, text('world'), true));
    expect(await res.text()).toBe('hello world');
    expect(s.session.activeStreams).toBe(0);
  });

  it('uploads a request body in chunks and ends it', async () => {
    const { socket, session } = setup();
    void session.handleRequest(
      new Request('https://abcd1234.via443.com/upload', { method: 'POST', body: 'x'.repeat(150 * 1024) }),
      ctx,
    );
    await tick();
    await tick();
    const [head, ...body] = socket.sent;
    expect(isEnd(head!)).toBe(false);
    expect(body.every((f) => f.type === FrameType.REQ_BODY)).toBe(true);
    expect(body.reduce((n, f) => n + f.payload.byteLength, 0)).toBe(150 * 1024);
    expect(body.every((f) => f.payload.byteLength <= 64 * 1024)).toBe(true);
    expect(isEnd(body.at(-1)!)).toBe(true);
  });

  it('stops uploading when the client has no credit left, and resumes on WINDOW', async () => {
    const { socket, session, reply } = setup();
    void session.handleRequest(
      new Request('https://abcd1234.via443.com/upload', { method: 'POST', body: 'x'.repeat(INITIAL_WINDOW + 100) }),
      ctx,
    );
    const bodyBytes = () =>
      socket.sent.filter((f) => f.type === FrameType.REQ_BODY).reduce((n, f) => n + f.payload.byteLength, 0);
    for (let i = 0; i < 10; i++) await tick();
    expect(bodyBytes()).toBe(INITIAL_WINDOW);
    expect(isEnd(socket.sent.at(-1)!)).toBe(false);

    reply(encodeWindow(socket.sent[0]!.streamId, 1024));
    for (let i = 0; i < 10; i++) await tick();
    expect(bodyBytes()).toBe(INITIAL_WINDOW + 100);
    expect(isEnd(socket.sent.at(-1)!)).toBe(true);
  });

  it('returns response credit only as the visitor reads', async () => {
    const { socket, session, reply } = setup();
    const pending = session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    const streamId = socket.sent[0]!.streamId;
    reply(encodeResponseHead(streamId, { status: 200, headers: [] }, false));
    const res = await pending;
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 4; i++) reply(encodeBody(FrameType.RES_BODY, streamId, chunk, false));
    await tick();
    const windows = () => socket.sent.filter((f) => f.type === FrameType.WINDOW);
    expect(windows()).toHaveLength(0);

    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    expect(windows().map(decodeWindow)).toEqual([INITIAL_WINDOW / 2]);
    expect(windows()[0]!.streamId).toBe(streamId);
  });

  it('closes the connection when the client overruns its window', async () => {
    const { socket, session, reply } = setup();
    const pending = session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    const streamId = socket.sent[0]!.streamId;
    reply(encodeResponseHead(streamId, { status: 200, headers: [] }, false));
    const res = await pending;
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 5; i++) reply(encodeBody(FrameType.RES_BODY, streamId, chunk, false));
    expect(socket.closedWith?.[0]).toBe(1002);
    expect(socket.closedWith?.[1]).toMatch(/window exceeded/);
    await expect(res.text()).rejects.toThrow(/disconnected/);
  });

  it('answers 502 when the client resets before responding', async () => {
    const { socket, session, reply } = setup();
    const pending = session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    reply(encodeReset(socket.sent[0]!.streamId, { code: 'upstream_error', message: 'ECONNREFUSED' }));
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('ECONNREFUSED');
  });

  it('returns a bodiless response for 204 and HEAD-style END heads', async () => {
    const { socket, session, reply } = setup();
    const pending = session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    reply(encodeResponseHead(socket.sent[0]!.streamId, { status: 204, headers: [] }, true));
    const res = await pending;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(session.activeStreams).toBe(0);
  });

  it('fails pending and streaming requests when the socket closes', async () => {
    const { socket, session, reply } = setup();
    const streaming = session.handleRequest(new Request('https://abcd1234.via443.com/a'), ctx);
    const waiting = session.handleRequest(new Request('https://abcd1234.via443.com/b'), ctx);
    reply(encodeResponseHead(socket.sent[0]!.streamId, { status: 200, headers: [] }, false));
    const res = await streaming;

    session.closed();
    expect((await waiting).status).toBe(502);
    await expect(res.text()).rejects.toThrow(/disconnected/);
    expect((await session.handleRequest(new Request('https://abcd1234.via443.com/c'), ctx)).status).toBe(502);
  });

  it('sends RESET when the visitor cancels the response body', async () => {
    const { socket, session, reply } = setup();
    const pending = session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    const streamId = socket.sent[0]!.streamId;
    reply(encodeResponseHead(streamId, { status: 200, headers: [] }, false));
    await (await pending).body!.cancel();
    const reset = socket.sent.at(-1)!;
    expect(reset.type).toBe(FrameType.RESET);
    expect(reset.streamId).toBe(streamId);
    expect(decodeReset(reset).code).toBe('cancelled');
    // Late frames for the cancelled stream are ignored.
    reply(encodeBody(FrameType.RES_BODY, streamId, text('late'), true));
    expect(socket.closedWith).toBeUndefined();
  });

  it('answers PING with PONG and closes on protocol errors', () => {
    const { socket, session, reply } = setup();
    reply({ type: FrameType.PING, flags: 0, streamId: 0, payload: text('hi') });
    expect(socket.sent[0]!.type).toBe(FrameType.PONG);
    expect(new TextDecoder().decode(socket.sent[0]!.payload)).toBe('hi');

    session.receive(new Uint8Array([0x7f, 0, 0, 0, 0, 0]));
    expect(socket.closedWith?.[0]).toBe(1002);
    expect(session.isClosed).toBe(true);
  });
});

describe('TunnelSession WebSockets', () => {
  const upgradeRequest = () =>
    new Request('https://abcd1234.via443.com/hmr', {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-protocol': 'vite-hmr' },
    });

  class FakeVisitor implements VisitorSocket {
    sent: (string | Uint8Array)[] = [];
    closedWith: [number | undefined, string | undefined] | undefined;
    send(data: string | Uint8Array, sent: () => void) {
      this.sent.push(data);
      sent();
    }
    close(code?: number, reason?: string) {
      this.closedWith = [code, reason];
    }
  }

  async function upgraded() {
    const s = setup();
    const pending = s.session.openWebSocket(upgradeRequest(), ctx);
    const open = s.socket.sent[0]!;
    s.reply(encodeResponseHead(open.streamId, { status: 101, headers: [['sec-websocket-protocol', 'vite-hmr']] }, false));
    const ws = await pending;
    if (!(ws instanceof TunnelWebSocket)) throw new Error('expected an upgrade');
    return { ...s, ws, streamId: open.streamId, open };
  }

  it('sends WS_OPEN and hands out the socket once the client answers 101', async () => {
    const { ws, open, session } = await upgraded();
    expect(open.type).toBe(FrameType.WS_OPEN);
    const head = decodeWsOpen(open);
    expect(head.path).toBe('/hmr');
    expect(head.headers).toContainEqual(['sec-websocket-protocol', 'vite-hmr']);
    expect(head.headers.map(([n]) => n)).not.toContain('upgrade');
    expect(ws.protocol).toBe('vite-hmr');
    expect(session.activeStreams).toBe(1);
  });

  it('delivers messages that arrive before the visitor is attached, then relays both ways', async () => {
    const { ws, streamId, reply, socket, session } = await upgraded();
    reply({ type: FrameType.WS_MSG, flags: WsFlags.END, streamId, payload: text('early') });
    reply({ type: FrameType.WS_MSG, flags: WsFlags.END | WsFlags.BINARY, streamId, payload: new Uint8Array([9]) });
    const visitor = new FakeVisitor();
    ws.attach(visitor);
    expect(visitor.sent).toEqual(['early', new Uint8Array([9])]);

    ws.message('hi');
    await tick();
    const msg = socket.sent.at(-1)!;
    expect(msg.type).toBe(FrameType.WS_MSG);
    expect(msg.flags).toBe(WsFlags.END);
    expect(new TextDecoder().decode(msg.payload)).toBe('hi');

    reply(encodeWsClose(streamId, { code: 4000, reason: 'bye' }));
    expect(visitor.closedWith).toEqual([4000, 'bye']);
    expect(session.activeStreams).toBe(0);
  });

  it('sends WS_CLOSE after queued messages when the visitor closes', async () => {
    const { ws, socket, session } = await upgraded();
    ws.attach(new FakeVisitor());
    ws.message('last words');
    ws.closed(1001, 'tab closed');
    await tick();
    const [msg, close] = socket.sent.slice(-2);
    expect(msg!.type).toBe(FrameType.WS_MSG);
    expect(decodeWsClose(close!)).toEqual({ code: 1001, reason: 'tab closed' });
    expect(session.activeStreams).toBe(0);
  });

  it('closes visitor sockets when the client disconnects', async () => {
    const { ws, session } = await upgraded();
    const visitor = new FakeVisitor();
    ws.attach(visitor);
    session.closed();
    expect(visitor.closedWith?.[0]).toBe(1001);
  });

  it("returns the local server's refusal as a plain response", async () => {
    const { socket, session, reply } = setup();
    const pending = session.openWebSocket(upgradeRequest(), ctx);
    const streamId = socket.sent[0]!.streamId;
    reply(encodeResponseHead(streamId, { status: 403, headers: [] }, false));
    reply(encodeBody(FrameType.RES_BODY, streamId, text('nope'), true));
    const res = await pending;
    if (!(res instanceof Response)) throw new Error('expected a response');
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('nope');
  });

  it('rejects 101 for plain requests and WebSocket frames before the upgrade', async () => {
    const plain = setup();
    const pending = plain.session.handleRequest(new Request('https://abcd1234.via443.com/'), ctx);
    plain.reply(encodeResponseHead(plain.socket.sent[0]!.streamId, { status: 101, headers: [] }, false));
    expect((await pending).status).toBe(502);

    const early = setup();
    void early.session.openWebSocket(upgradeRequest(), ctx);
    early.reply({ type: FrameType.WS_MSG, flags: WsFlags.END, streamId: early.socket.sent[0]!.streamId, payload: text('x') });
    expect(early.socket.closedWith?.[0]).toBe(1002);
  });
});

describe('ids', () => {
  it('generates 8-character [a-z0-9] tunnel ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateTunnelId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isTunnelId(id)).toBe(true);
    expect(isTunnelId('ABCD1234')).toBe(false);
    expect(isTunnelId('www')).toBe(false);
  });

  it('generates url-safe resume tokens', () => {
    expect(generateResumeToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('matchHost', () => {
  it('recognises the apex and tunnel hosts', () => {
    expect(matchHost('via443.com', 'via443.com')).toEqual({ kind: 'apex' });
    expect(matchHost('VIA443.com:443', 'via443.com')).toEqual({ kind: 'apex' });
    expect(matchHost('abcd1234.via443.com', 'via443.com')).toEqual({ kind: 'tunnel', tunnelId: 'abcd1234' });
    expect(matchHost('abcd1234.localhost:8080', 'localhost:8080')).toEqual({ kind: 'tunnel', tunnelId: 'abcd1234' });
  });

  it('rejects other hosts', () => {
    for (const host of [undefined, '', 'www.via443.com', 'a.abcd1234.via443.com', 'abcd1234.evil.com', 'abcd1234.localhost:9999']) {
      expect(matchHost(host, host?.includes('localhost') ? 'localhost:8080' : 'via443.com').kind).toBe('unknown');
    }
  });
});

describe('parseConnectRequest', () => {
  const connect = (headers: Record<string, string>) =>
    parseConnectRequest(new Request('https://via443.com/connect', { headers }));
  const valid = { upgrade: 'websocket', [ConnectHeader.PROTOCOL]: String(PROTOCOL_VERSION), authorization: 'Bearer tok' };

  it('accepts a valid upgrade with an optional resume header', () => {
    expect(connect(valid)).toEqual({ ok: true, token: 'tok', resume: undefined });
    expect(connect({ ...valid, [ConnectHeader.RESUME]: 'abcd1234:secret' })).toEqual({
      ok: true,
      token: 'tok',
      resume: { tunnelId: 'abcd1234', resumeToken: 'secret' },
    });
  });

  it('rejects missing upgrade, wrong version and missing token', async () => {
    const cases: [Record<string, string>, number, string][] = [
      [{ ...valid, upgrade: '' }, 426, 'websocket_required'],
      [{ ...valid, [ConnectHeader.PROTOCOL]: '999' }, 426, 'unsupported_protocol'],
      [{ ...valid, authorization: '' }, 401, 'unauthorized'],
    ];
    for (const [headers, status, code] of cases) {
      const result = connect(headers);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.response.status).toBe(status);
      expect(((await result.response.json()) as { code: string }).code).toBe(code);
    }
  });
});
