// What the quick ask on an agent's tile shows, worked out from its ask: whether the tile has the chip, which question
// opens first, what each answer says, and where the next answer moves to. `QuickAsk.tsx` only draws this.
import type { Agent, AgentAsk, AskAnswer, AskQuestion, PermissionPrompt, PromptQuestion } from '@agent-board/daemon/protocol';

/**
 * A question the quick ask draws: an ask's, or one of Claude's dialog's, which may have a header, a description under
 * each option, and take several answers (`multiSelect`, tick boxes).
 */
export interface QuickAskQuestion extends AskQuestion {
  header?: string;
  descriptions?: string[];
  multiSelect?: boolean;
}

/** An answer the quick ask keeps: an ask's, or several options of a question that takes several. */
export type QuickAskAnswer = AskAnswer | { options: number[] };

/** The part of an ask, or of Claude's dialog, the quick ask draws. */
export interface QuickAskData {
  questions: QuickAskQuestion[];
  answers: (QuickAskAnswer | null)[];
}

/** A question prompt of Claude's the board can answer (its `dialog` kept by the daemon). */
export type DialogPrompt = PermissionPrompt & { questions: PromptQuestion[]; dialog: NonNullable<PermissionPrompt['dialog']> };

/**
 * Claude's question dialog as the quick ask draws it: each question with its options' labels and descriptions, and
 * Other (the user's own words) as its words field, which Claude's dialog always offers.
 */
export function dialogAsk(prompt: DialogPrompt): QuickAskData {
  return {
    questions: prompt.questions.map(({ question, header, options, multiSelect }) => ({
      question,
      header,
      options: options.map((option) => option.label),
      descriptions: options.map((option) => option.description),
      multiSelect,
      freeText: true,
    })),
    answers: prompt.dialog.answers,
  };
}

/**
 * Where Claude's question prompt is: `open` for the board to answer; `sent` once its answers went, until its call runs;
 * `kept-open` once Claude kept its dialog up after them; `terminal` where only its terminal can answer it (a subagent's,
 * one whose questions can't all be read, or its hold over).
 */
export function dialogStatus(prompt: PermissionPrompt): 'open' | 'sent' | 'kept-open' | 'terminal' {
  const { dialog } = prompt;
  if (dialog === null || prompt.questions === null) return 'terminal';
  if (dialog.keptOpen) return 'kept-open';
  if (dialog.sentAt !== null) return 'sent';
  return prompt.heldUntil === null ? 'terminal' : 'open';
}

/** Whether the prompt is Claude's question dialog with answers the board keeps, open or sent. */
export const isDialogPrompt = (prompt: PermissionPrompt): prompt is DialogPrompt => prompt.questions !== null && prompt.dialog !== null;

/**
 * The ask the agent's tile opens from its chip, if it has one: the ask it waits on, once no permission prompt comes
 * first, that isn't on the board as a steps card. One asked on the board whose card was taken off comes back here.
 */
export function quickAskOf(agent: Pick<Agent, 'ask' | 'permissions'>): AgentAsk | undefined {
  const { ask } = agent;
  if (ask === null || agent.permissions.length > 0 || ask.card !== null) return undefined;
  return ask;
}

/**
 * Claude's question dialog the agent's tile opens from its chip, if it has one the board can answer: once no permission
 * prompt comes first (`dialogStatus` isn't `terminal`).
 */
export function tileDialogOf(agent: Pick<Agent, 'permissions'>): DialogPrompt | undefined {
  if (agent.permissions.some((prompt) => prompt.questions === null)) return undefined;
  return agent.permissions.find((prompt): prompt is DialogPrompt => isDialogPrompt(prompt) && dialogStatus(prompt) !== 'terminal');
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

/** The answer as words: the option picked (several joined by ", ", in the question's order) or the user's own; null while unanswered or skipped. */
export function answerText(question: AskQuestion, answer: QuickAskAnswer | null | undefined): string | null {
  if (answer === null || answer === undefined || 'skip' in answer) return null;
  if ('options' in answer) return [...answer.options].sort((a, b) => a - b).map((option) => question.options[option] ?? '').join(', ');
  return 'option' in answer ? (question.options[answer.option] ?? null) : answer.text.trim();
}

/** The chip's words: how many questions it asks. */
export const chipWords = (ask: QuickAskData) => (ask.questions.length === 1 ? '1 question' : `${ask.questions.length} questions`);

/** The tile's tooltip while it asks: its first question, and how many it asks. */
export function askTitle(name: string, ask: QuickAskData): string {
  const more = ask.questions.length === 1 ? '' : ` (${chipWords(ask)})`;
  return `${name} asks: ${ask.questions[0]!.question}${more}`;
}
