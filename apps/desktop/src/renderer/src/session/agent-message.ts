// What the chat makes of a message another agent sent (ADR-0023): what it says, what the receiver was also told, how
// long it is, and what a chat that shows only the user's own messages makes of it.

import { agentRefOf, HAND_OFF_HEAD, SEND_TRAILER, type Agent, type Harness, type MessageSender } from '@agent-board/daemon/protocol';
import type { ChatItem } from './chat';

/** Past this many lines an agent's message folds, with Show all. */
export const CLAMP_LINES = 4;

/** About how many characters fill a line of a chat, for a long line to count as the lines it wraps to. */
const LINE_CHARS = 56;

export interface AgentMessageParts {
  /** What the sender wrote. */
  body: string;
  /** What the board added for the receiver: how to answer, or a hand-off's head. The chat tucks it under a badge. */
  aside?: string;
}

/** `text` split into what the sender wrote and the line the board added to it, if any. */
export function agentMessageParts(text: string, from: MessageSender): AgentMessageParts {
  const head = from.kind === 'hand-off' ? HAND_OFF_HEAD.exec(text) : null;
  if (head !== null) return { body: text.slice(head[0].length), aside: head[0].slice(0, -': '.length) };
  const trailer = SEND_TRAILER.exec(text);
  if (trailer !== null) return { body: text.slice(0, trailer.index), aside: trailer[1]! };
  return { body: text };
}

/** Whether `text` runs past the clamp: by its lines, or by one line long enough to wrap past it. */
export function isLong(text: string): boolean {
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / LINE_CHARS)), 0);
  return lines > CLAMP_LINES;
}

/** The kind a message came as, as its pill says it. */
export function messageKindLabel(from: MessageSender): string {
  if (from.kind === 'hand-off') return from.payload === undefined ? 'Hand-off' : `Hand-off · ${from.payload}`;
  return from.kind === 'reply' ? 'Reply' : 'Message';
}

/**
 * The items of a chat that shows only the user's own messages: each run of agent messages one `agents-hidden` item,
 * counting them, so nothing vanishes without a trace. With agents included, the same items.
 */
export function foldAgentMessages(items: ChatItem[], includeAgents: boolean): ChatItem[] {
  if (includeAgents) return items;
  const out: ChatItem[] = [];
  for (const item of items) {
    if (item.kind !== 'user' || item.from === undefined) {
      out.push(item);
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === 'agents-hidden') out[out.length - 1] = { ...last, count: last.count + 1 };
    else out.push({ kind: 'agents-hidden', key: `agents-hidden-${item.key}`, count: 1 });
  }
  return out;
}

/** Who a sender is, as far as the board still knows them: what their character looks like. */
export interface SenderLook {
  harness: Harness;
  master: boolean;
}

/** The agent a sender's ref (`agent:` and the start of its session id) names, if the board still has it. */
export function senderLook(agents: readonly Agent[], ref: string): SenderLook | undefined {
  const agent = agents.find((each) => ref === agentRefOf(each.sessionId));
  return agent && { harness: agent.harness, master: agent.master };
}

/** The colour family of a sender's bubble: the Captain's teal, or its harness's colour (Claude's when it is gone). */
export type SenderTone = 'captain' | Harness;

export const senderTone = (look: SenderLook | undefined): SenderTone => (look?.master ? 'captain' : (look?.harness ?? 'claude'));
