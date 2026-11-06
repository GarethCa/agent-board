// What the quick ask on an agent's tile shows, worked out from its ask: whether the tile has the chip, which question
// opens first, what each answer says, and where the next answer moves to. `QuickAsk.tsx` only draws this.
import type { Agent, AgentAsk, AskAnswer, AskQuestion } from '@agent-board/daemon/protocol';

/** The part of an ask the quick ask draws. */
export type QuickAskData = Pick<AgentAsk, 'questions' | 'answers'>;

/**
 * The ask the agent's tile opens from its chip, if it has one: the ask it waits on, once no permission prompt comes
 * first, that isn't on the board as a steps card. One asked on the board whose card was taken off comes back here.
 */
export function quickAskOf(agent: Pick<Agent, 'ask' | 'permissions'>): AgentAsk | undefined {
  const { ask } = agent;
  if (ask === null || agent.permissions.length > 0 || ask.card !== null) return undefined;
  return ask;
}

/** The question the ask opens on: its first unanswered one, else the answers and Send (`questions.length`). */
export function firstOpen(ask: QuickAskData): number {
  if (ask.questions.length === 1) return 0;
  const open = ask.answers.findIndex((answer) => answer === null);
  return open < 0 ? ask.questions.length : open;
}

/** Where to go once question `index` is answered: the next unanswered question after it, then before it, else Send. */
export function nextAfter(ask: QuickAskData, index: number): number {
  const count = ask.questions.length;
  for (let step = 1; step < count; step += 1) {
    const at = (index + step) % count;
    if (ask.answers[at] === null) return at;
  }
  return count;
}

/** The answer as words: the option picked or the user's own; null while unanswered or skipped. */
export function answerText(question: AskQuestion, answer: AskAnswer | null | undefined): string | null {
  if (answer === null || answer === undefined || 'skip' in answer) return null;
  return 'option' in answer ? (question.options[answer.option] ?? null) : answer.text.trim();
}

/** The chip's words: how many questions it asks. */
export const chipWords = (ask: QuickAskData) => (ask.questions.length === 1 ? '1 question' : `${ask.questions.length} questions`);

/** The tile's tooltip while it asks: its first question, and how many it asks. */
export function askTitle(name: string, ask: QuickAskData): string {
  const more = ask.questions.length === 1 ? '' : ` (${chipWords(ask)})`;
  return `${name} asks: ${ask.questions[0]!.question}${more}`;
}
