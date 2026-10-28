import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

/** Picks the proxy for a target from HTTPS_PROXY / https_proxy, honoring NO_PROXY / no_proxy. */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const raw = target.protocol === 'wss:' || target.protocol === 'https:'
    ? (env.HTTPS_PROXY ?? env.https_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy ?? env.HTTPS_PROXY ?? env.https_proxy);
  if (!raw) return undefined;
  if (bypassesProxy(target, env.NO_PROXY ?? env.no_proxy ?? '')) return undefined;
  return new URL(raw.includes('://') ? raw : `http://${raw}`);
}

/** curl-style NO_PROXY matching: `*`, host names and domain suffixes, optional ports, IPv4 CIDRs. */
export function bypassesProxy(target: URL, noProxy: string): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'wss:' || target.protocol === 'https:' ? '443' : '80');
  for (let entry of noProxy.split(/[\s,]+/)) {
    entry = entry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const cidr = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidr) {
      if (net.isIPv4(host) && inCidr(host, cidr[1]!, Number(cidr[2]))) return true;
      continue;
    }
    let entryHost = entry;
    const portMatch = !net.isIPv6(entry) && entry.match(/^(.*):(\d+)$/);
    if (portMatch) {
      if (portMatch[2] !== port) continue;
      entryHost = portMatch[1]!;
    }
    entryHost = entryHost.replace(/^\*?\./, '').replace(/^\[|\]$/g, '');
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const toInt = (addr: string) => addr.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/**
 * CA certificates to trust, or undefined to use Node's defaults.
 *
 * Node already adds NODE_EXTRA_CA_CERTS to its defaults, but ignores SSL_CERT_FILE.
 * Sandboxes and corporate networks often set only one of them, so when
 * SSL_CERT_FILE is set we build the list ourselves from the bundled roots plus both files.
 */
export function trustedCAs(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (!env.SSL_CERT_FILE) return undefined;
  const files = [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].filter((f): f is string => !!f);
  const extra: string[] = [];
  for (const file of files) {
    try {
      extra.push(readFileSync(file, 'utf8'));
    } catch {
      // A missing file is not fatal; TLS verification will fail loudly if the CA was needed.
    }
  }
  return [...tls.rootCertificates, ...extra];
}

export interface ConnectOptions {
  target: URL;
  proxy: URL | undefined;
  ca: string[] | undefined;
  signal?: AbortSignal;
}

/**
 * Opens a socket to the target's host and port, through an HTTP CONNECT proxy
 * if one is given, and wraps it in TLS for wss:// targets. TLS is always verified.
 */
export async function openSocket({ target, proxy, ca, signal }: ConnectOptions): Promise<net.Socket> {
  const secure = target.protocol === 'wss:' || target.protocol === 'https:';
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || (secure ? 443 : 80));

  const raw = proxy ? await connectThroughProxy(proxy, host, port, signal) : await connectDirect(host, port, signal);
  if (!secure) return raw;

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      servername: net.isIP(host) ? undefined : host,
      ca,
      ALPNProtocols: ['http/1.1'],
    });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('secureConnect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
    signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
  });
}

function connectDirect(host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('connect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
    signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
  });
}

async function connectThroughProxy(proxy: URL, host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
  const socket =
    proxy.protocol === 'https:'
      ? await openSocket({ target: new URL(`https://${proxy.host}`), proxy: undefined, ca: trustedCAs(), signal })
      : await connectDirect(proxyHost, proxyPort, signal);

  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  let request = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
  if (proxy.username) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    request += `Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}\r\n`;
  }
  socket.write(`${request}\r\n`);

  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error(`proxy ${proxy.host} closed the connection during CONNECT`));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > 16 * 1024) fail(new Error('proxy sent an oversized CONNECT response'));
        return;
      }
      cleanup();
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('latin1');
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`proxy ${proxy.host} refused CONNECT ${authority}: ${statusLine}`));
        return;
      }
      // Stop flowing mode so no bytes are dropped before TLS or the WebSocket takes over.
      socket.pause();
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
  });
}
