import { useCallback, useSyncExternalStore } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { agentAtWork, pastedParts, type Transcript } from './chat';

/**
 * A message sent from a chat's message box, shown in the chat at once and until the agent's transcript has its copy:
 * typing it at the agent's prompt, and the agent taking it up, can take from a moment to the rest of a turn.
 */
export interface SentMessage {
  id: string;
  text: string;
  /** The paths of images pasted into it, which the harness writes as it likes. */
  images: string[];
  /**
   * Where the transcript the chat has ended as it was sent: its copy is written after that. Null until the chat has
   * read the transcript; a message from an earlier generation is placed again at the end of the next one read.
   */
  after: TranscriptEnd | null;
  /**
   * `sending` until the daemon answers; then `sent` (typed at the agent's prompt), `waiting` (held until its session is
   * up), or `failed`, saying why in `error`.
   */
  status: 'sending' | 'sent' | 'waiting' | 'failed';
  /** Whether the agent was in a turn as it was sent, so it takes the message only once the turn ends. */
  midTurn: boolean;
  /**
   * How many turns the agent has started since it was sent: the one a message sent while it was idle starts counts,
   * the one it was sent into doesn't.
   */
  turns: number;
  /** A command (`/compact`, `!ls`), which the harness keeps out of the conversation: it goes once delivered. */
  command: boolean;
  error?: string;
}

/** Where a transcript the chat read ends: the number of the entry after its last, in that generation. */
export interface TranscriptEnd {
  generation: number;
  end: number;
}

/** A message the transcript has a copy of, and where that copy ends. */
export interface Confirmed {
  id: string;
  at: TranscriptEnd;
}

/**
 * Which messages the transcript doesn't show yet, and which it does. A copy is a message of the user's written after
 * the message was sent whose words are the message's: spacing, a paste's wrapper and an image (its path as sent, how
 * the harness writes it in the copy) don't count. Two or more sent one after another may come as one copy, as two
 * sent in one turn can reach the agent as one message. Each copy confirms only the messages it is made of; the store
 * then places the messages still waiting after it (`confirm`), so it never confirms another. A message not placed in
 * the transcript's generation, and a command, wait.
 */
export function settle(messages: readonly SentMessage[], transcript: Transcript | undefined): { waiting: SentMessage[]; confirmed: Confirmed[] } {
  if (transcript?.status !== 'ok') return { waiting: [...messages], confirmed: [] };
  const copies = transcript.entries.map((entry) => (entry.kind === 'user' ? copyWords(entry.text) : undefined));
  const matchable = messages.filter((message) => !message.command && message.after?.generation === transcript.generation);
  const confirmed: Confirmed[] = [];
  const done = new Set<string>();
  matchable.forEach((message, from) => {
    if (done.has(message.id)) return;
    for (let index = Math.max(0, message.after!.end - transcript.first); index < copies.length; index += 1) {
      const copy = copies[index];
      if (copy === undefined) continue;
      // This message alone, or with those sent after it, in order, if they could have been in it too.
      const parts: string[] = [];
      for (let to = from; to < matchable.length && matchable[to]!.after!.end - transcript.first <= index; to += 1) {
        parts.push(messageWords(matchable[to]!));
        const joined = parts.filter(Boolean).join(' ');
        if (joined === copy) {
          const at = { generation: transcript.generation, end: transcript.first + index + 1 };
          for (const each of matchable.slice(from, to + 1)) {
            done.add(each.id);
            confirmed.push({ id: each.id, at });
          }
          copies[index] = undefined;
          return;
        }
        if (!copy.startsWith(joined)) break;
      }
    }
  });
  return { waiting: messages.filter((message) => !done.has(message.id)), confirmed };
}

/** A message's words as sent, its images' paths left out. */
function messageWords(message: SentMessage): string {
  return words(message.images.reduce((text, image) => text.split(image).join(' '), message.text));
}

/** A copy's words, its images (`[Image #1]`) left out. */
function copyWords(text: string): string {
  return words(text.replace(/\[Image #\d+\]/g, ' '));
}

/** A message's words, one space between each: what was pasted in it unwrapped. */
function words(text: string): string {
  return pastedParts(text)
    .map((part) => part.text)
    .join('\n')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** What a sent message's bubble says until the transcript shows it. */
export function sentLabel(message: SentMessage, agent: Pick<Agent, 'harness' | 'endedAt' | 'state' | 'queuedUntilUp' | 'undelivered'>): string {
  if (message.status === 'failed') return `Not sent: ${message.error}`;
  if (message.status === 'waiting') {
    const never = agent.undelivered.find((each) => each.text === message.text);
    if (never !== undefined) return `Not delivered: ${never.reason}`;
    if (agent.queuedUntilUp > 0) return 'waiting for the session to start';
  }
  const atWork = agentAtWork(agent);
  // A turn came and went with no copy: the harness took it as something else, or never took it.
  if (message.status !== 'sending' && message.turns > 0 && !atWork) return 'Not seen in the transcript';
  // Held until its session was up, it was typed behind the first prompt's turn.
  if ((message.midTurn || message.status === 'waiting') && atWork) return QUEUED[agent.harness];
  return 'sending…';
}

/** What a message sent mid-turn waits for: Claude takes it at the turn's next step, Codex once the turn ends. */
const QUEUED: Record<Agent['harness'], string> = {
  claude: 'queued: taken at its next step',
  codex: 'queued: delivered when the turn ends',
};

type Send = (sessionId: string, text: string, paste: boolean) => Promise<{ queued: boolean }>;

/** What a harness takes as a command rather than a message: a slash command's name (not a path), or a shell command. */
const COMMAND = /^\s*(\/[A-Za-z][\w:-]*(\s|$)|!)/;

/** The messages each session's chat has sent and its transcript doesn't show yet, and where its transcript ends. */
export function createSentMessages(answer: Send) {
  let bySession = new Map<string, readonly SentMessage[]>();
  const ends = new Map<string, TranscriptEnd>();
  const listeners = new Set<() => void>();
  let ids = 0;

  const get = (sessionId: string): readonly SentMessage[] => bySession.get(sessionId) ?? NONE;
  const set = (sessionId: string, change: (messages: readonly SentMessage[]) => readonly SentMessage[]) => {
    const before = get(sessionId);
    const next = change(before);
    if (next === before) return;
    bySession = new Map(bySession).set(sessionId, next);
    for (const listener of listeners) listener();
  };
  const update = (sessionId: string, id: string, change: Partial<SentMessage>) =>
    set(sessionId, (messages) => messages.map((message) => (message.id === id ? { ...message, ...change } : message)));
  const drop = (sessionId: string, id: string) => set(sessionId, (messages) => messages.filter((message) => message.id !== id));

  const deliver = async (sessionId: string, message: SentMessage) => {
    try {
      const { queued } = await answer(sessionId, message.text, message.images.length > 0);
      if (message.command && !queued) drop(sessionId, message.id);
      else update(sessionId, message.id, { status: queued ? 'waiting' : 'sent' });
    } catch (problem) {
      update(sessionId, message.id, { status: 'failed', error: errorMessage(problem) });
    }
  };

  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Notes where the session's transcript, as its chat has it, ends now, and places there the messages not placed in
     * its generation: sent before the chat first read it, or before it was read afresh.
     */
    read(sessionId: string, end: TranscriptEnd) {
      ends.set(sessionId, end);
      // Sent while there was no transcript yet, every entry of the first one read is newer.
      const place = (message: SentMessage): SentMessage =>
        message.after?.generation === end.generation
          ? message
          : { ...message, after: message.after?.generation === NO_TRANSCRIPT ? { generation: end.generation, end: 0 } : end };
      set(sessionId, (messages) => (messages.some((message) => message.after?.generation !== end.generation) ? messages.map(place) : messages));
    },
    /** Shows `text` in the session's chat and sends it; `images`, the paths pasted into the box, are pasted with it. */
    send(sessionId: string, text: string, images: readonly string[], midTurn: boolean): Promise<void> {
      const message: SentMessage = {
        id: `sent-${++ids}`,
        text,
        images: images.filter((image) => text.includes(image)),
        after: ends.get(sessionId) ?? null,
        status: 'sending',
        midTurn,
        turns: 0,
        command: COMMAND.test(text),
      };
      set(sessionId, (messages) => [...messages, message]);
      return deliver(sessionId, message);
    },
    /** Sends a message that failed again. */
    retry(sessionId: string, id: string, midTurn: boolean): Promise<void> {
      const message = get(sessionId).find((each) => each.id === id);
      if (message === undefined) return Promise.resolve();
      const again: SentMessage = { ...message, status: 'sending', midTurn, turns: 0, error: undefined, after: ends.get(sessionId) ?? message.after };
      update(sessionId, id, again);
      return deliver(sessionId, again);
    },
    /** Drops the messages the transcript shows, and places those still waiting after the copies that showed them. */
    confirm(sessionId: string, confirmed: readonly Confirmed[]) {
      if (confirmed.length === 0) return;
      const gone = new Set(confirmed.map((each) => each.id));
      set(sessionId, (messages) =>
        messages
          .filter((message) => !gone.has(message.id))
          .map((message) => {
            const past = confirmed.reduce(
              (end, { at }) => (at.generation === message.after?.generation ? Math.max(end, at.end) : end),
              message.after?.end ?? 0,
            );
            return message.after === null || past === message.after.end ? message : { ...message, after: { ...message.after, end: past } };
          }),
      );
    },
    /** Counts a turn the agent started for every message sent before it. */
    turnStarted(sessionId: string) {
      set(sessionId, (messages) => (messages.length === 0 ? messages : messages.map((message) => ({ ...message, turns: message.turns + 1 }))));
    },
    /** Drops a message the user gave up on. */
    drop,
  };
}

const NONE: readonly SentMessage[] = [];

/** The generation of a transcript that isn't there (yet): the daemon's never number one 0. */
const NO_TRANSCRIPT = 0;

/** The app's sent messages: each chat's message box sends through it, and its chat shows them. */
export const sentMessages = createSentMessages((sessionId, text, paste) => window.agentBoard.agents.answer(sessionId, text, paste));

/** The messages the session's chat has sent that its transcript doesn't show yet. */
export function useSentMessages(sessionId: string): readonly SentMessage[] {
  const get = useCallback(() => sentMessages.get(sessionId), [sessionId]);
  return useSyncExternalStore(sentMessages.subscribe, get);
}
