import { describe, expect, it } from 'vitest';
import { leavePlan, type BoardSession } from '../src/board-ops.ts';
import type { DaemonClient } from '../src/client.ts';

/** A board session whose daemon answers `answer` to the plan, and the calls it was given. */
function session(answer: unknown) {
  const calls: [string, unknown][] = [];
  const client = { call: (method: string, params: unknown) => (calls.push([method, params]), Promise.resolve(answer)) } as unknown as DaemonClient;
  return { calls, session: { client, socketPath: '', caller: { kind: 'agent' }, token: 'token', close: () => undefined } as unknown as BoardSession };
}

describe('agent-board doc --plan', () => {
  const plan = { title: 'Cache pages', body: '# Cache', format: 'markdown' as const, onBoard: true };

  it('leaves the plan with the daemon, and returns at once with where the decision comes', async () => {
    const { calls, session: board } = session({ left: { version: 3, expiresAt: null, left: true } });
    const view = await leavePlan(board, plan);
    expect(calls).toEqual([['board.presentPlan', { token: 'token', ...plan, detached: true }]]);
    expect(view.text).toContain('Plan v3 shown to the user');
    expect(view.text).toContain('comes to your prompt as a message, however long it takes');
    expect(view.text).not.toMatch(/minute|hour/);
  });

  it('tells a crew member its plan went to its orchestrator, as the held call does', async () => {
    const { session: board } = session({ sentTo: 'orchestrator', name: 'lead' });
    const view = await leavePlan(board, plan);
    expect(view.text).toMatch(/You were started by lead, so your plan went to it, not to the user/);
  });
});
