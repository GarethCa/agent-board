import { randomBytes } from 'node:crypto';

/** Hears each step of one message's delivery, for the daemon log: queued, typed, a turn started on it, or not. */
export type SendTrail = (step: string) => void;

/**
 * A trail for one message of `chars` characters sent to `sessionId`: each step is a timed daemon log line, by a short
 * id that ties the steps together (`send 3fa9c1 to <session> (15 chars): turn started on it`). Never what the message
 * says, which may be secret.
 */
export function sendTrail(log: (message: string) => void, sessionId: string, chars: number): SendTrail {
  const id = randomBytes(3).toString('hex');
  return (step) => log(`send ${id} to ${sessionId} (${chars} chars): ${step}`);
}

/**
 * The daemon log line of what became of the message typed at `sessionId`'s prompt and never sent (its draft): sent on
 * by `--submit` or the tile's Send, or cleared. It has no send id of its own: its session and time match it to its
 * send's `left as a draft` line.
 */
export function draftLine(sessionId: string, step: string): string {
  return `send draft at ${sessionId}: ${step}`;
}
