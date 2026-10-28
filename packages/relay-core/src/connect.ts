import { ConnectHeader, PROTOCOL_VERSION, parseBearer, parseResume, type ResumeRequest } from '@via443/protocol';
import { connectErrorResponse } from './responses.ts';

export type ConnectRequest =
  | { ok: true; token: string; resume: ResumeRequest | undefined }
  | { ok: false; response: Response };

/**
 * Validates a client's `/connect` upgrade request before the relay looks up the
 * token. Authentication itself is up to the caller.
 */
export function parseConnectRequest(req: Request): ConnectRequest {
  if (req.method !== 'GET' || req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return { ok: false, response: connectErrorResponse(426, 'websocket_required', 'Expected a WebSocket upgrade.') };
  }
  const version = req.headers.get(ConnectHeader.PROTOCOL);
  if (version !== String(PROTOCOL_VERSION)) {
    return {
      ok: false,
      response: connectErrorResponse(
        426,
        'unsupported_protocol',
        `This relay speaks protocol version ${PROTOCOL_VERSION}, the client sent ${version ?? 'none'}. Update the via443 client.`,
      ),
    };
  }
  const token = parseBearer(req.headers.get('authorization'));
  if (!token) {
    return { ok: false, response: connectErrorResponse(401, 'unauthorized', 'An API token is required.') };
  }
  return { ok: true, token, resume: parseResume(req.headers.get(ConnectHeader.RESUME)) };
}
