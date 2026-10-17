import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from './states';

const agent = (patch: Partial<Agent>) => ({ state: 'waiting', seen: false, endedAt: null, permissions: [], ask: null, plan: null, exitCode: null, shellSessionId: null, shellHarness: null, ...patch }) as Agent;

describe("an agent's pill", () => {
  it('shows an unseen waiting agent as waiting', () => {
    expect(agentPill(agent({}))).toEqual({ state: 'waiting', label: STATE_LABELS.waiting });
  });

  it('drops the needs-you look once seen, keeping the name of what it waits for', () => {
    expect(agentPill(agent({ seen: true }))).toEqual({ state: 'idle', label: STATE_LABELS.waiting });
    expect(agentPill(agent({ seen: true }), TILE_STATE_LABELS)).toEqual({ state: 'idle', label: TILE_STATE_LABELS.waiting });
  });

  it('draws a starting agent as running, labelled starting', () => {
    expect(agentPill(agent({ state: 'starting' }), TILE_STATE_LABELS)).toEqual({ state: 'running', label: 'starting' });
  });

  it('says an ended agent ended and how it exited, coloured by its exit code, seen or not', () => {
    expect(agentPill(agent({ seen: true, state: 'done', endedAt: '2026-01-01', exitCode: 0 }))).toEqual({ state: 'done', label: 'ended · exit 0' });
    expect(agentPill(agent({ state: 'failed', endedAt: '2026-01-01', exitCode: 1 }), TILE_STATE_LABELS)).toEqual({ state: 'failed', label: 'ended · exit 1' });
    // One that ended the session itself but exited non-zero is still coloured by its exit code.
    expect(agentPill(agent({ state: 'done', endedAt: '2026-01-01', exitCode: 2 }))).toEqual({ state: 'failed', label: 'ended · exit 2' });
    // Killed, with no exit code.
    expect(agentPill(agent({ state: 'failed', endedAt: '2026-01-01', exitCode: null }))).toEqual({ state: 'failed', label: 'ended' });
  });

  it('does not show an agent the user stopped as failed: no exit code, but done', () => {
    expect(agentPill(agent({ state: 'done', endedAt: '2026-01-01', exitCode: null }))).toEqual({ state: 'done', label: 'ended' });
  });

  it('keeps the stopped look for an agent a restart stopped, and its own state for one done but not ended', () => {
    expect(agentPill(agent({ state: 'stopped-by-restart', endedAt: '2026-01-01', exitCode: null }))).toEqual({ state: 'stopped-by-restart', label: STATE_LABELS['stopped-by-restart'] });
    // Never a red ended, whatever exit code it was left with, and on the tile too.
    expect(agentPill(agent({ state: 'stopped-by-restart', endedAt: '2026-01-01', exitCode: 1 }), TILE_STATE_LABELS)).toEqual({ state: 'stopped-by-restart', label: 'stopped' });
    expect(agentPill(agent({ state: 'done' }))).toEqual({ state: 'done', label: STATE_LABELS.done });
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
