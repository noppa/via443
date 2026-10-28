/** Who opened a tunnel: the user and the API token they used. */
export interface TunnelOwner {
  userId: string;
  tokenId: string;
}

/** How long a disconnected tunnel keeps its ID for a resume. */
export const RESUME_GRACE_MS = 10 * 60_000;

/** WebSocket close code sent to a session that is replaced by a resumed connection. */
export const CLOSE_REPLACED = 4000;
/** WebSocket close code sent when the tunnel's token is revoked or its user disabled. */
export const CLOSE_REVOKED = 4001;
