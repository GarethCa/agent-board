import { describe, expect, it } from 'vitest';
import { AGENT_STATES } from '@agent-board/daemon/protocol';
import { composerBlock } from './composer-block';

const live = { endedAt: null, state: 'idle', reviewOf: null } as const;

describe('composerBlock', () => {
  it('takes messages in every state of a live agent, working or waiting included', () => {
    // Every state but the two that block, so a new state has to be decided here.
    const sending = AGENT_STATES.filter((state) => state !== 'needs-permission' && state !== 'stopped-by-restart');
    expect(sending).toContain('handing-off');
    for (const state of sending) expect(composerBlock({ ...live, state })).toBeUndefined();
  });

  it('points at the terminal while a permission prompt waits', () => {
    expect(composerBlock({ ...live, state: 'needs-permission' })).toEqual({ reason: 'Waiting on a permission prompt', action: 'show-prompt' });
  });

  it('offers to resume an agent a restart stopped', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'stopped-by-restart' })).toEqual({
      reason: 'Stopped by a restart',
      action: 'resume',
    });
  });

  it('offers to restart an agent that ended', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'done' })).toEqual({ reason: 'The agent has ended', action: 'restart' });
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'failed' })).toEqual({ reason: 'The agent has ended', action: 'restart' });
  });

  it("offers a reviewer, whose round ended with it, no way to restart", () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'done', reviewOf: 'impl-1' })).toEqual({ reason: 'The agent has ended' });
  });
});
