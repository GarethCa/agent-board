import { describe, expect, it } from 'vitest';
import type { AgentAsk, PermissionPrompt, PlanSummary } from '@agent-board/daemon/protocol';
import { decisionId, deferDecision, deferredDecision, deferredDecisions, paneDecision, showsStepsStrip, subscribeDeferred } from './pane-decision';

const ask: AgentAsk = {
  id: 'ask-1',
  question: 'Who is the guide for?',
  options: ['New developers', 'The product team'],
  freeText: true,
  askedAt: '2026-10-31T09:00:00Z',
  expiresAt: '2026-10-31T09:30:00Z',
  onBoard: false,
  questions: [{ question: 'Who is the guide for?', options: ['New developers', 'The product team'], freeText: true }],
  answers: [null],
  card: null,
};

const plan = {
  id: 'plan-2',
  version: 2,
  title: 'Zone id migration',
  format: 'markdown',
  presentedAt: '2026-10-31T09:00:00Z',
  expiresAt: null,
  left: false,
  decision: null,
  author: 'agent',
} as PlanSummary;

const prompt = (id: string, heldUntil: string | null = '2026-10-31T09:00:20Z'): PermissionPrompt => ({
  id,
  toolName: 'Bash',
  toolInput: { command: 'pnpm test' },
  subagent: null,
  requestedAt: '2026-10-31T09:00:00Z',
  heldUntil,
  asksInTerminal: false,
  sessionGrant: null, dialog: null, plan: null, questions: null,
});

describe('paneDecision: a permission prompt', () => {
  it('is the oldest prompt the board still holds the harness for, ahead of a question or plan', () => {
    const first = prompt('p1');
    expect(paneDecision({ ask, plan, permissions: [first, prompt('p2')] })).toEqual({ kind: 'permission', prompt: first });
  });

  it('is never one asking in the terminal now, which the banner above sends the user to', () => {
    expect(paneDecision({ ask: null, plan: null, permissions: [prompt('p1', null)] })).toBeUndefined();
    expect(paneDecision({ ask, plan: null, permissions: [prompt('p1', null)] })?.kind).toBe('ask');
  });

  it('passes to the next prompt once one is put off, and decisionId names it by its prompt', () => {
    const permissions = [prompt('p1'), prompt('p2')];
    expect(decisionId({ kind: 'permission', prompt: permissions[0]! })).toBe('p1');
    expect(paneDecision({ ask: null, plan: null, permissions }, new Set(['p1']))).toEqual({ kind: 'permission', prompt: permissions[1] });
    expect(deferredDecision({ ask: null, plan: null, permissions }, new Set(['p1']))).toEqual({ kind: 'permission', prompt: permissions[0] });
  });
});

describe('paneDecision', () => {
  it('is none while the agent waits on nothing', () => {
    expect(paneDecision({ ask: null, plan: null })).toBeUndefined();
  });

  it('is the question the agent asks', () => {
    expect(paneDecision({ ask, plan: null })).toEqual({ kind: 'ask', ask });
  });

  it('is the plan still to be decided, whether or not the agent went on without waiting', () => {
    expect(paneDecision({ ask: null, plan })).toEqual({ kind: 'plan', plan });
    expect(paneDecision({ ask: null, plan: { ...plan, left: true } })).toEqual({ kind: 'plan', plan: { ...plan, left: true } });
  });

  it('is never a plan already decided', () => {
    expect(paneDecision({ ask: null, plan: { ...plan, decision: { outcome: 'approved', comments: '', decidedAt: '2026-10-31T09:05:00Z' } } })).toBeUndefined();
  });

  it('puts the question first when the agent has both', () => {
    expect(paneDecision({ ask, plan })?.kind).toBe('ask');
  });

  it('is none once put off, and comes back for a new question or plan version', () => {
    const deferred = new Set([ask.id, plan.id]);
    expect(paneDecision({ ask, plan: null }, deferred)).toBeUndefined();
    expect(paneDecision({ ask: null, plan }, deferred)).toBeUndefined();
    expect(paneDecision({ ask: { ...ask, id: 'ask-2' }, plan: null }, deferred)).toEqual({ kind: 'ask', ask: { ...ask, id: 'ask-2' } });
    expect(paneDecision({ ask: null, plan: { ...plan, id: 'plan-3', version: 3 } }, deferred)?.kind).toBe('plan');
  });

  it('shows the plan still to be decided once the question before it is put off', () => {
    expect(paneDecision({ ask, plan: { ...plan, left: true } }, new Set([ask.id]))).toEqual({ kind: 'plan', plan: { ...plan, left: true } });
  });
});

describe('deferredDecision', () => {
  it('is the decision put off, still pending, and none for one not put off', () => {
    expect(deferredDecision({ ask, plan: null }, new Set([ask.id]))).toEqual({ kind: 'ask', ask });
    expect(deferredDecision({ ask, plan: null }, new Set())).toBeUndefined();
    expect(deferredDecision({ ask: null, plan: null }, new Set([ask.id]))).toBeUndefined();
    expect(deferredDecision({ ask, plan }, new Set([plan.id]))).toEqual({ kind: 'plan', plan });
  });
});

describe('decisionId', () => {
  it('is the question’s id, or the plan version’s', () => {
    expect(decisionId({ kind: 'ask', ask })).toBe('ask-1');
    expect(decisionId({ kind: 'plan', plan })).toBe('plan-2');
  });
});

describe('deferDecision', () => {
  it('puts a decision off and brings it back, telling each listener once per change', () => {
    let heard = 0;
    const stop = subscribeDeferred(() => heard++);
    deferDecision('ask-9');
    deferDecision('ask-9');
    expect(deferredDecisions().has('ask-9')).toBe(true);
    deferDecision('ask-9', false);
    expect(deferredDecisions().has('ask-9')).toBe(false);
    expect(heard).toBe(2);
    stop();
  });
});

describe("the strip of the steps card an agent waits on, above its composer", () => {
  const stepsWait = { kind: 'steps' as const, itemId: 'card-1', title: 'Release 1.4', stepId: 's1', text: 'Which database?', open: 2, since: '2026-10-31T09:00:00Z' };
  const waiting = { ask: null, plan: null, stepsWait };

  it('shows while the agent waits on a card, in either design and view, and never without one', () => {
    expect(showsStepsStrip(waiting, { simplified: false, chat: false })).toBe(true);
    expect(showsStepsStrip(waiting, { simplified: false, chat: true })).toBe(true);
    expect(showsStepsStrip(waiting, { simplified: true, chat: false })).toBe(true);
    expect(showsStepsStrip({ ...waiting, stepsWait: null }, { simplified: true, chat: true })).toBe(false);
  });

  it("stands back while the Simplified chat's pane shows a decision, one at a time, and shows again once it is put off", () => {
    const asking = { ...waiting, ask };
    expect(showsStepsStrip(waiting, { simplified: true, chat: true })).toBe(true);
    expect(showsStepsStrip(asking, { simplified: true, chat: true })).toBe(false);
    // Classic has no pane: the strip shows beside the question.
    expect(showsStepsStrip(asking, { simplified: false, chat: true })).toBe(true);
    expect(showsStepsStrip(asking, { simplified: true, chat: true }, new Set([ask.id]))).toBe(true);
  });
});
