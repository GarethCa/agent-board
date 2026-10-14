import { createHash, randomBytes } from 'node:crypto';

/**
 * A new random token: a session's hook token (ADR-0004), its board token (ADR-0010), or the external hooks' token,
 * handed out in an environment.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the daemon keeps in place of a token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
