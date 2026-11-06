import { describe, expect, it } from 'vitest';
import type { AgentAsk, AskAnswer } from '@agent-board/daemon/protocol';
import { answerText, askTitle, chipWords, firstOpen, nextAfter, quickAskOf } from './quick-ask';

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
