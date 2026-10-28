import type { ConnectError } from '@via443/protocol';

/** JSON error for the `/connect` endpoint, read by the client. */
export function connectErrorResponse(status: number, code: string, message: string): Response {
  const body: ConnectError = { code, message };
  return Response.json(body, { status });
}

/** Plain-text error shown to someone visiting a tunnel URL. */
export function tunnelErrorResponse(status: number, message: string): Response {
  return new Response(`via443: ${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
