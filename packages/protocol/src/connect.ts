/**
 * The client opens a tunnel with a WebSocket upgrade request to CONNECT_PATH on
 * the relay's apex domain, carrying these headers:
 *
 *   Authorization: Bearer <api token>
 *   Via443-Protocol: <PROTOCOL_VERSION>
 *   Via443-Resume: <tunnelId>:<resumeToken>     (optional, when reconnecting)
 *
 * The relay answers with a plain HTTP error (401, 426, …) and a JSON
 * `ConnectError` body, or accepts the upgrade and sends WELCOME as its first frame.
 */

export const PROTOCOL_VERSION = 1;

export const CONNECT_PATH = '/connect';

export const ConnectHeader = {
  PROTOCOL: 'via443-protocol',
  RESUME: 'via443-resume',
} as const;

export interface ConnectError {
  code: string;
  message: string;
}

export interface ResumeRequest {
  tunnelId: string;
  resumeToken: string;
}

export function formatResume(resume: ResumeRequest): string {
  return `${resume.tunnelId}:${resume.resumeToken}`;
}

export function parseResume(value: string | null | undefined): ResumeRequest | undefined {
  if (!value) return undefined;
  const sep = value.indexOf(':');
  if (sep <= 0 || sep === value.length - 1) return undefined;
  return { tunnelId: value.slice(0, sep), resumeToken: value.slice(sep + 1) };
}

export function parseBearer(value: string | null | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}
