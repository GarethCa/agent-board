import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { canRestart, exitText } from './RestartAgent';

const agent = (fields: Partial<Agent>): Agent =>
  ({ harness: 'claude', state: 'done', endedAt: '2026-10-11T12:00:00.000Z', exitCode: 0, reviewOf: null, ...fields }) as Agent;

describe('restarting an ended agent', () => {
  it('is offered for an agent that ended, not one still running or stopped by a restart (which has Resume)', () => {
    expect(canRestart(agent({}))).toBe(true);
    expect(canRestart(agent({ state: 'failed', exitCode: 1 }))).toBe(true);
    expect(canRestart(agent({ state: 'running', endedAt: null }))).toBe(false);
    expect(canRestart(agent({ state: 'stopped-by-restart' }))).toBe(false);
  });

  it('is not offered for a reviewer, whose round ended with it', () => {
    expect(canRestart(agent({ reviewOf: 'implementer' }))).toBe(false);
  });

  it('says how its process went, with the code when there is one', () => {
    expect(exitText(agent({}))).toBe('claude exited (code 0)');
    expect(exitText(agent({ harness: 'codex', exitCode: null }))).toBe('codex exited');
  });
});
