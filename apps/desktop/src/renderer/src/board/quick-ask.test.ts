import { describe, expect, it } from 'vitest';
import type { AgentAsk, AskAnswer, PermissionPrompt } from '@agent-board/daemon/protocol';
import { answerText, askTitle, chipWords, dialogAsk, dialogStatus, firstOpen, nextAfter, quickAskOf, tileDialogOf, type DialogPrompt } from './quick-ask';

const QUESTIONS = [
  { question: 'Where should the rate limiter live?', options: ['Gateway', 'Each service'], freeText: false },
  { question: 'Keep the old limit for internal calls?', options: ['Yes', 'No'], freeText: false },
  { question: 'Anything else?', options: [], freeText: true },
];

const ask = (answers: (AskAnswer | null)[] = [null, null, null], fields: Partial<AgentAsk> = {}): AgentAsk => ({
  id: 'q1',
  question: QUESTIONS[0]!.question,
  options: QUESTIONS[0]!.options,
  freeText: false,
  askedAt: '',
  expiresAt: '',
  onBoard: false,
  questions: QUESTIONS,
  answers,
  card: null,
  ...fields,
});

describe('the quick ask on a tile', () => {
  it('opens from the tile’s chip only for an ask the agent waits on, not one put on the board, or behind a prompt', () => {
    expect(quickAskOf({ ask: ask(), permissions: [] })?.id).toBe('q1');
    expect(quickAskOf({ ask: null, permissions: [] })).toBeUndefined();
    // Asked on the board, it is on its card; its card taken off, it is back on the tile.
    expect(quickAskOf({ ask: ask(undefined, { onBoard: true }), permissions: [] })?.id).toBe('q1');
    expect(quickAskOf({ ask: ask(undefined, { card: 'card-1' }), permissions: [] })).toBeUndefined();
    expect(quickAskOf({ ask: ask(), permissions: [{} as never] })).toBeUndefined();
  });

  it('opens on its first unanswered question, else on the answers and Send; a single question on itself', () => {
    expect(firstOpen(ask())).toBe(0);
    expect(firstOpen(ask([{ option: 0 }, null, null]))).toBe(1);
    expect(firstOpen(ask([{ option: 0 }, { option: 1 }, { text: 'No' }]))).toBe(3);
    expect(firstOpen({ questions: [QUESTIONS[0]!], answers: [{ option: 1 }] })).toBe(0);
  });

  it('moves on to the next unanswered question, wrapping round, and to Send once all are answered', () => {
    expect(nextAfter(ask([{ option: 0 }, null, null]), 0)).toBe(1);
    expect(nextAfter(ask([null, { option: 0 }, null]), 1)).toBe(2);
    expect(nextAfter(ask([null, { option: 0 }, { text: 'x' }]), 2)).toBe(0);
    expect(nextAfter(ask([{ option: 0 }, { option: 1 }, { text: 'x' }]), 2)).toBe(3);
  });

  it('says each answer in words, the chip how many it asks, and the tooltip its first question', () => {
    expect(answerText(QUESTIONS[0]!, { option: 1 })).toBe('Each service');
    expect(answerText(QUESTIONS[2]!, { text: '  Ship Friday ' })).toBe('Ship Friday');
    expect(answerText(QUESTIONS[2]!, null)).toBeNull();
    expect(answerText(QUESTIONS[2]!, { skip: true })).toBeNull();
    expect(chipWords(ask())).toBe('3 questions');
    expect(chipWords({ questions: [QUESTIONS[0]!], answers: [null] })).toBe('1 question');
    expect(askTitle('impl-2', ask())).toBe('impl-2 asks: Where should the rate limiter live? (3 questions)');
  });
});

describe("Claude's question dialog in the quick ask", () => {
  const CLAUDE_QUESTIONS = [
    { question: 'Which cache?', header: 'Cache', options: [{ label: 'Redis', description: 'Shared across nodes' }, { label: 'In memory', description: '' }], multiSelect: false },
    { question: 'Which pages?', header: 'Scope', options: [{ label: 'Product', description: '' }, { label: 'Category', description: '' }, { label: 'Search', description: '' }], multiSelect: true },
  ];
  const prompt = (fields: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
    id: 'q',
    toolName: 'AskUserQuestion',
    toolInput: { questions: CLAUDE_QUESTIONS },
    subagent: null,
    requestedAt: '',
    heldUntil: '2026-11-12T10:00:00.000Z',
    asksInTerminal: true,
    sessionGrant: null,
    questions: CLAUDE_QUESTIONS,
    dialog: { answers: [null, null], sentAt: null, keptOpen: false },
    plan: null,
    ...fields,
  });
  const bash: PermissionPrompt = { ...prompt(), id: 'p', toolName: 'Bash', questions: null, dialog: null };

  it('draws its questions with their headers, descriptions, tick boxes where it takes several, and Other as words', () => {
    const data = dialogAsk(prompt() as DialogPrompt);
    expect(data.questions).toEqual([
      { question: 'Which cache?', header: 'Cache', options: ['Redis', 'In memory'], descriptions: ['Shared across nodes', ''], multiSelect: false, freeText: true },
      { question: 'Which pages?', header: 'Scope', options: ['Product', 'Category', 'Search'], descriptions: ['', '', ''], multiSelect: true, freeText: true },
    ]);
    expect(data.answers).toEqual([null, null]);
  });

  it('words several options in the question’s order, as Claude takes them', () => {
    expect(answerText({ question: 'Which pages?', options: ['Product', 'Category', 'Search'], freeText: true }, { options: [2, 0] })).toBe('Product, Search');
  });

  it('is open to answer while held, sent once its answers went, kept open once Claude kept its dialog up, else for its terminal', () => {
    expect(dialogStatus(prompt())).toBe('open');
    expect(dialogStatus(prompt({ heldUntil: null, dialog: { answers: [{ option: 0 }, { options: [0] }], sentAt: '2026-11-12T10:00:00.000Z', keptOpen: false } }))).toBe('sent');
    expect(dialogStatus(prompt({ heldUntil: null, dialog: { answers: [{ option: 0 }, { options: [0] }], sentAt: '2026-11-12T10:00:00.000Z', keptOpen: true } }))).toBe('kept-open');
    // A subagent's, or one whose questions couldn't all be read: no dialog kept. Its hold over: only its terminal now.
    expect(dialogStatus(prompt({ dialog: null }))).toBe('terminal');
    expect(dialogStatus(prompt({ heldUntil: null }))).toBe('terminal');
    expect(dialogStatus(bash)).toBe('terminal');
  });

  it('opens from the tile’s chip once no permission comes first, and not where only its terminal can answer', () => {
    expect(tileDialogOf({ permissions: [prompt()] })?.id).toBe('q');
    expect(tileDialogOf({ permissions: [bash, prompt()] })).toBeUndefined();
    expect(tileDialogOf({ permissions: [prompt({ dialog: null })] })).toBeUndefined();
    expect(tileDialogOf({ permissions: [] })).toBeUndefined();
  });
});
