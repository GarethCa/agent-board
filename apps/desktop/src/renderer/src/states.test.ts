import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from './states';

const agent = (patch: Partial<Agent>) => ({ state: 'waiting', seen: false, endedAt: null, permissions: [], ask: null, plan: null, shellSessionId: null, shellHarness: null, ...patch }) as Agent;

describe("an agent's pill", () => {
  it('shows an unseen waiting agent as waiting', () => {
    expect(agentPill(agent({}))).toEqual({ state: 'waiting', label: STATE_LABELS.waiting });
  });

  it('drops the needs-you look once seen, keeping the name of what it waits for', () => {
    expect(agentPill(agent({ seen: true }))).toEqual({ state: 'idle', label: STATE_LABELS.waiting });
    expect(agentPill(agent({ seen: true }), TILE_STATE_LABELS)).toEqual({ state: 'idle', label: TILE_STATE_LABELS.waiting });
  });

  it('lets an ended agent show its own state, seen or not', () => {
    expect(agentPill(agent({ seen: true, state: 'done', endedAt: '2026-01-01' }))).toEqual({ state: 'done', label: STATE_LABELS.done });
  });

  it('says what a waiting agent asks of you: a question, or a plan to review', () => {
    const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '' };
    const plan = { id: 'p1', version: 1, title: 'Plan', format: 'markdown' as const, presentedAt: '', expiresAt: '', decision: null };
    expect(agentPill(agent({ ask }), TILE_STATE_LABELS)).toEqual({ state: 'waiting', label: 'asks you' });
    expect(agentPill(agent({ plan }))).toEqual({ state: 'waiting', label: 'plan to review' });
    expect(agentPill(agent({ plan, seen: true }))).toEqual({ state: 'idle', label: 'plan to review' });
    expect(agentPill(agent({ state: 'running', plan: { ...plan, decision: { outcome: 'approved', comments: '', decidedAt: '' } } }))).toEqual({ state: 'running', label: STATE_LABELS.running });
  });
});
