// The Simplified design's Timeline view as segments: what was said to the agent, and the line saying how many of the
// agents' messages are hidden, off the rail; and between those each
// turn's steps on the rail, every call one of them, with the time down the side.

import type { ChatItem, SubagentMessage, ToolCall } from './chat';

/** One step on the rail; `at` is the time shown beside it, given only when its minute is not the one last shown. */
export type RailStep =
  | { kind: 'item'; key: string; item: Exclude<ChatItem, { kind: 'user' | 'tools' | 'agents-hidden' }>; at?: string }
  /** `lastRun`: the call is in the conversation's last run of calls, so it may still be running. */
  | { kind: 'call'; key: string; call: ToolCall; lastRun?: true; at?: string }
  | { kind: 'message'; key: string; message: SubagentMessage; at?: string };

export type RailSegment =
  | { kind: 'said'; item: Extract<ChatItem, { kind: 'user' }> }
  | { kind: 'hidden'; item: Extract<ChatItem, { kind: 'agents-hidden' }> }
  | { kind: 'turn'; key: string; steps: RailStep[] };

const minuteOf = (at: string | undefined) => {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 60_000);
};

/**
 * The conversation as the rail draws it. A message the user or another agent sent is said, off the rail, as is a run
 * of agents' messages hidden; the rest between two of them is a turn, a run of calls one step per call. The call the live line stands at is left to it.
 */
export function railTurns(items: readonly ChatItem[], liveCallId?: string): RailSegment[] {
  const segments: RailSegment[] = [];
  let turn: Extract<RailSegment, { kind: 'turn' }> | undefined;
  let shown: number | undefined;
  const step = (next: RailStep, at: string | undefined) => {
    if (turn === undefined) {
      turn = { kind: 'turn', key: `turn-${next.key}`, steps: [] };
      segments.push(turn);
      shown = undefined;
    }
    const minute = minuteOf(at);
    if (minute !== undefined && minute !== shown) {
      shown = minute;
      next.at = at;
    }
    turn.steps.push(next);
  };
  items.forEach((item, index) => {
    if (item.kind === 'user') {
      segments.push({ kind: 'said', item });
      turn = undefined;
    } else if (item.kind === 'agents-hidden') {
      segments.push({ kind: 'hidden', item });
      turn = undefined;
    } else if (item.kind === 'tools') {
      for (const row of item.rows) {
        if (row.kind === 'subagent-message') step({ kind: 'message', key: row.key, message: row }, item.at);
        else if (row.id !== liveCallId) step({ kind: 'call', key: row.id, call: row, ...(index === items.length - 1 ? { lastRun: true as const } : {}) }, row.at);
      }
    } else {
      step({ kind: 'item', key: item.key, item }, item.at);
    }
  });
  return segments;
}
