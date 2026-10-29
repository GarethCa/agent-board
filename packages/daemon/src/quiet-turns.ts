// The safety net under a Claude agent's turn ending: its Stop hook lost, it would show working at its prompt for good.
import { open, type FileHandle } from 'node:fs/promises';
import type { Clock } from './clock.ts';
import { readStartupScreen } from './startup-screen.ts';

/**
 * How long a Claude agent's turn may go with no hook and no output before its screen is read for its prompt. A turn at
 * work never goes this long without either: Claude's spinner redraws through every tool call and every wait on the model.
 */
export const QUIET_TURN_MS = 5 * 60_000;

/**
 * What Claude 2.1.312 draws over its prompt box through a turn, any one of which says a turn is under way: its spinner
 * line (a glyph of `·✢✳✶✻✽`, `*` on some terminals, still under reduced motion, then its verb and an ellipsis), and
 * its footer's hint, whose key follows the user's binding (`esc to interrupt`) and which team mode replaces. Neither is
 * sure to be on screen: a narrow terminal truncates the footer, which is why the transcript is read too.
 */
const TURN_UNDER_WAY = [/^[·✢✳✶✻✽*]\s+\S[^…]*…/, /\bto interrupt\b/i, /\bto return to team lead\b/i];

/**
 * Whether the visible `lines` of a Claude session's screen, box drawing taken out (`screenLines`), show its prompt
 * between turns: its prompt box (`readStartupScreen`), with nothing of a turn under way over it.
 */
export function showsIdlePrompt(lines: readonly string[]): boolean {
  return !lines.some((line) => TURN_UNDER_WAY.some((sign) => sign.test(line))) && readStartupScreen(lines).kind === 'prompt';
}

/** How much of a transcript's end is read for its last entries: enough for a long reply. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The whole lines in the last `maxBytes` of the file at `path`; none if it can't be read. */
export async function readTranscriptTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): Promise<string[]> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // The first line read from the middle of the file is cut through.
    return (start > 0 ? lines.slice(1) : lines).filter((line) => line !== '');
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

/** An entry of a Claude transcript, as far as a turn's end is read from it. */
interface TranscriptEntry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  message?: { id?: unknown; content?: unknown };
}

/** Whether `entry` is of the conversation itself: a prompt, a tool result or a reply, not a subagent's, a note or a summary. */
const ofConversation = (entry: TranscriptEntry) =>
  (entry.type === 'user' || entry.type === 'assistant') && entry.isSidechain !== true && entry.isMeta !== true && entry.isCompactSummary !== true;

const callsTool = (entry: TranscriptEntry) =>
  Array.isArray(entry.message?.content) && (entry.message.content as { type?: unknown }[]).some((part) => part?.type === 'tool_use');

/**
 * Whether the last `lines` of a Claude transcript say its turn ended: its last entry of the conversation is a reply
 * whose message (which Claude may write over several lines) called no tool. After a prompt or a tool result the turn
 * waits on the model; after a tool call, on the tool, however long it is silent. Undefined when no line says.
 */
export function turnEndedInTranscript(lines: readonly string[]): boolean | undefined {
  let reply: unknown;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(lines[index]!) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object' || !ofConversation(entry)) continue;
    if (reply !== undefined && (entry.type !== 'assistant' || entry.message?.id !== reply)) return true;
    if (entry.type === 'user' || callsTool(entry)) return false;
    reply = entry.message?.id ?? null;
    // A reply with no id of its own can't be followed back to the rest of its message.
    if (reply === null) return true;
  }
  return reply === undefined ? undefined : true;
}

interface QuietTurnOptions {
  clock: Clock;
  /** The agent has been at work with no hook and no output for `QUIET_TURN_MS`, and again each spell it stays so. */
  check(sessionId: string): void;
}

/** Times the quiet in each Claude agent's turn: how long since its last hook or output while it was at work. */
export function createQuietTurns({ clock, check }: QuietTurnOptions) {
  /** Each agent at work: when its quiet began, and how many signs of work it has given, which no two share. */
  const quiet = new Map<string, { since: number; generation: number; cancel: () => void }>();
  let generations = 0;
  const arm = (sessionId: string, ms: number) =>
    clock.setTimer(() => {
      const entry = quiet.get(sessionId);
      if (entry === undefined) return;
      const left = entry.since + QUIET_TURN_MS - clock.now();
      if (left > 0) {
        entry.cancel = arm(sessionId, left);
        return;
      }
      entry.since = clock.now();
      entry.cancel = arm(sessionId, QUIET_TURN_MS);
      check(sessionId);
    }, ms);

  return {
    /** A hook left the agent at work: its quiet starts now. */
    working(sessionId: string) {
      const entry = quiet.get(sessionId);
      if (entry === undefined) quiet.set(sessionId, { since: clock.now(), generation: ++generations, cancel: arm(sessionId, QUIET_TURN_MS) });
      else Object.assign(entry, { since: clock.now(), generation: ++generations });
    },

    /** The agent's terminal printed something: if it is at work, its quiet starts again. */
    activity(sessionId: string) {
      const entry = quiet.get(sessionId);
      if (entry !== undefined) Object.assign(entry, { since: clock.now(), generation: ++generations });
    },

    /** The agent is no longer at work (its turn ended, it was interrupted, or its process exited): its quiet goes. */
    stopped(sessionId: string) {
      quiet.get(sessionId)?.cancel();
      quiet.delete(sessionId);
    },

    /**
     * The agent's latest sign of work, if it is at work: a check that waited compares it before and after, as a sign in
     * the same instant leaves the time its quiet began as it was.
     */
    generation: (sessionId: string) => quiet.get(sessionId)?.generation,
  };
}
