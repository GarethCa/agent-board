import type { NeedsYouKind } from '@agent-board/daemon/protocol';
import type { AppNotification } from './notifications-types';

/** How many answers a banner lists under its Options: past that the question is for the agent's window. */
export const MAX_ANSWERS = 5;

/** What a notification shows. */
export interface Banner {
  title: string;
  /** The Simplified design's second line: what kind of request this is. */
  subtitle?: string;
  body: string;
  /** The buttons under Options, in order; picking one answers the question. Only a question has any. */
  answers: string[];
}

const KIND_WORDS: Record<NeedsYouKind, string> = {
  permission: 'Permission',
  asks: 'Question',
  plan: 'Plan to review',
  flagged: 'Needs you',
  turn: 'Finished',
};

/**
 * How a notification is drawn. Classic: its sentence and body, as ever. The Simplified design: as macOS draws a banner,
 * the agent, what kind of request, then the request, with a question's answers as its Options. A banner never allows:
 * a permission has no answers, so clicking it opens the agent.
 */
export function bannerOf(notification: AppNotification, simplified: boolean): Banner {
  const { kind, title, body, name, ask } = notification;
  // The app's own notifications (the test one) have no agent or kind to draw.
  if (!simplified || kind === undefined) return { title, body, answers: [] };
  // Past what a banner can list, none: the agent's window shows every choice, rather than a partial menu here.
  const answers = kind === 'asks' && ask !== undefined && ask.options.length <= MAX_ANSWERS ? ask.options : [];
  // The answers are buttons, so the question alone is the body.
  return { title: name ?? title, subtitle: KIND_WORDS[kind], body: answers.length > 0 ? ask!.question : body, answers };
}

/** What answering a banner needs of the daemon and the app. */
export interface AnswerTools {
  answer(params: { sessionId: string; askId: string; answer: { option: number } }): Promise<unknown>;
  openAgent(sessionId: string): void;
}

/**
 * What picking the `index`th answer of a banner does: answers the question. A question that no longer asks (answered,
 * timed out or gone) refuses, and the agent's window opens to show how it stands, as a click on the banner would.
 */
export function answerBanner({ sessionId, ask }: AppNotification, index: number, { answer, openAgent }: AnswerTools): void {
  if (sessionId === undefined) return;
  if (ask === undefined) return openAgent(sessionId);
  answer({ sessionId, askId: ask.askId, answer: { option: index } }).catch(() => openAgent(sessionId));
}
