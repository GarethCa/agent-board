import { describe, expect, it } from 'vitest';
import type { GateRun, GateStep } from '@agent-board/daemon/protocol';
import { gateHeadline, gateTone, mergedText, shownStep, staleNote, withGateChange } from './gate-view';

const HEAD = '9b41e07'.padEnd(40, '0');
const OLD = '3f2a1c9'.padEnd(40, '0');

const step = (name: string, status: GateStep['status']): GateStep => ({
  name,
  status,
  startedAt: status === 'waiting' ? null : '2026-10-14T14:02:00.000Z',
  endedAt: status === 'passed' || status === 'failed' || status === 'stopped' ? '2026-10-14T14:02:30.000Z' : null,
});

const run = (fields: Partial<GateRun> = {}): GateRun => ({
  sessionId: 's1',
  command: 'pnpm check:local',
  commit: HEAD,
  dirty: false,
  startedAt: '2026-10-14T14:02:00.000Z',
  endedAt: '2026-10-14T14:05:05.000Z',
  status: 'passed',
  exitCode: 0,
  steps: [step('lint', 'passed'), step('e2e', 'passed')],
  ...fields,
});

describe('the gate tab (BL1)', () => {
  it("keeps each agent's latest run, replacing the one before", () => {
    const first = run();
    const second = run({ status: 'running', endedAt: null });
    expect(withGateChange(withGateChange(new Map(), { type: 'gate.updated', run: first }), { type: 'gate.updated', run: second })).toEqual(new Map([['s1', second]]));
  });

  it('heads the tab with how the run is doing, and how long it has taken', () => {
    const now = Date.parse('2026-10-14T14:03:48.000Z');
    expect(gateHeadline(run({ status: 'running', endedAt: null }), now)).toBe('Running · 1m 48s');
    expect(gateHeadline(run(), now)).toBe('Passed: 2 of 2 · 3m 5s');
    expect(gateHeadline(run({ status: 'failed', steps: [step('lint', 'passed'), step('e2e', 'failed')] }), now)).toBe('Failed: 1 of 2 passed · 3m 5s');
    expect(gateHeadline(run({ status: 'stopped' }), now)).toBe('Stopped · 3m 5s');
  });

  it("colours its tab's dot by the run", () => {
    expect(gateTone(run({ status: 'running' }))).toBe('running');
    expect(gateTone(run())).toBe('passed');
    expect(gateTone(run({ status: 'failed' }))).toBe('failed');
    expect(gateTone(run({ status: 'stopped' }))).toBe('idle');
  });

  it('shows the step the user picked, else the one running, else the first failed, else the last', () => {
    const steps = [step('lint', 'passed'), step('test', 'running'), step('e2e', 'waiting')];
    expect(shownStep(run({ status: 'running', steps }), undefined)).toBe('test');
    expect(shownStep(run({ status: 'running', steps }), 'lint')).toBe('lint');
    expect(shownStep(run({ status: 'failed', steps: [step('lint', 'failed'), step('e2e', 'failed')] }), undefined)).toBe('lint');
    expect(shownStep(run(), undefined)).toBe('e2e');
    expect(shownStep(run(), 'gone')).toBe('e2e');
  });

  it('greys a run on an older commit, or one with uncommitted changes', () => {
    expect(staleNote(run(), HEAD)).toBeUndefined();
    expect(staleNote(run({ commit: OLD }), HEAD)).toBe('on 3f2a1c9, head is now 9b41e07');
    expect(staleNote(run({ dirty: true }), HEAD)).toBe('on 9b41e07, with uncommitted changes');
    expect(staleNote(run({ commit: OLD }), null)).toBeUndefined();
  });


});

describe('the merge popover (BM3)', () => {

  it('says what the merge did, and what failed, in a sentence', () => {
    const names = { agent: 'Fix checkout flake', branch: 'fix-checkout', issue: 'STO-112' };
    expect(mergedText(41, 'main', { done: ['worktree', 'close'], failed: [{ step: 'comment', why: 'Linear is down' }] }, names)).toBe(
      "Merged #41 into main. Closed Fix checkout flake, removed its worktree, couldn't comment on STO-112 (Linear is down).",
    );
    expect(mergedText(41, 'main', { done: [], failed: [] }, names)).toBe('Merged #41 into main.');
    // Kept for one reason, said once.
    const why = 'its worktree has moved on to 9b41e07 since the merged 3f2a1c9, so it is kept, with its branch';
    expect(mergedText(41, 'main', { done: ['close'], failed: [{ step: 'worktree', why }, { step: 'branch', why }] }, names)).toBe(
      `Merged #41 into main. Closed Fix checkout flake, kept its worktree and fix-checkout (${why}).`,
    );
  });
});

