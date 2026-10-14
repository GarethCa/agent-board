import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { invalidParams } from './params.ts';
import type { FlowEdgePayload } from './protocol.ts';

/** The most a file payload may be: it is typed to the agent at the other end. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * A file payload's path, tidied: relative to the worktree and inside it. Throws `invalidParams` for an empty one, an
 * absolute one, or one that climbs out of the worktree.
 */
export function checkPayloadPath(path: string): string {
  const tidy = normalize(path.trim()).replace(/[\\/]+$/, '');
  if (tidy === '' || tidy === '.') throw invalidParams('a payload file needs a path in its agent\'s worktree');
  if (isAbsolute(tidy) || tidy === '..' || tidy.startsWith(`..${sep}`)) {
    throw invalidParams(`${path.trim()} is not inside its agent's worktree: give a path relative to it`);
  }
  return tidy;
}

/** What a payload is called on its edge's label and in the hand-off: `final message`, or its file's own name. */
export function payloadName(payload: FlowEdgePayload, path: string | null): string {
  return payload === 'final-message' || path === null ? 'final message' : basename(path);
}

export interface PayloadSource {
  payload: FlowEdgePayload;
  /** For a file payload, relative to `worktree`. */
  path: string | null;
  worktree: string;
  /** The agent's final message from the turn it last finished, if it has finished one. */
  finalMessage: string | undefined;
}

/**
 * A payload as read now: `text` to deliver (JSON on one line) and `shown` for a preview (JSON indented), or why it
 * can't be.
 */
export type PayloadRead = { name: string; text: string; shown: string; bytes: number } | { name: string; problem: string };

/**
 * Reads what an edge carries from its `from` agent: its final message, or a file in its worktree as it is now. A file
 * must stay inside the worktree, through any symbolic link, be at most `MAX_PAYLOAD_BYTES`, and for JSON parse.
 */
export async function readPayload(source: PayloadSource): Promise<PayloadRead> {
  const name = payloadName(source.payload, source.path);
  if (source.payload === 'final-message' || source.path === null) {
    const text = source.finalMessage;
    if (text === undefined) {
      return { name, problem: 'its agent has no final message: it has not finished a turn yet' };
    }
    return { name, text, shown: text, bytes: Buffer.byteLength(text) };
  }
  const file = join(source.worktree, source.path);
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    return { name, problem: `there is no ${source.path} in its worktree` };
  }
  const within = relative(await realpath(source.worktree), real);
  if (within === '' || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) {
    return { name, problem: `${source.path} leads out of its worktree` };
  }
  const stats = await stat(real);
  if (!stats.isFile()) return { name, problem: `${source.path} is not a file` };
  if (stats.size > MAX_PAYLOAD_BYTES) {
    return { name, problem: `${source.path} is over ${MAX_PAYLOAD_BYTES / 1024} KB, too big to hand on as a message` };
  }
  const raw = await readFile(real, 'utf8');
  if (source.payload === 'handover') return { name, text: raw, shown: raw, bytes: stats.size };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { name, problem: `${source.path} is not JSON: ${(error as Error).message}` };
  }
  return { name, text: JSON.stringify(value), shown: JSON.stringify(value, null, 2), bytes: stats.size };
}
