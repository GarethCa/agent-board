import type { Agent } from '@agent-board/daemon/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RestartAgentResult } from '../../../preload/api';
import { cancelledLine, clickableLinksView, restartForLinks, startedOtherwise, wakeAnyway } from './clickable-links';

const agent = (fields: Partial<Agent>): Agent => ({ sessionId: 'a', name: 'Ada', harness: 'claude', endedAt: null, clickableLinks: true, ...fields }) as Agent;

describe('the clickable links switch', () => {
  it('is on until the settings are read, then shows the setting', () => {
    expect(clickableLinksView(undefined)).toEqual({ checked: true, locked: false });
    expect(clickableLinksView({ clickableLinks: false, clickableLinksFromEnvironment: null })).toEqual({ checked: false, locked: false });
  });

  it("shows the user's own FORCE_HYPERLINK, locked, whatever the setting says", () => {
    expect(clickableLinksView({ clickableLinks: false, clickableLinksFromEnvironment: true })).toEqual({ checked: true, locked: true });
    expect(clickableLinksView({ clickableLinks: true, clickableLinksFromEnvironment: false })).toEqual({ checked: false, locked: true });
  });
});

describe('the agents the restart offer counts', () => {
  const agents = [
    agent({ sessionId: 'with' }),
    agent({ sessionId: 'without', clickableLinks: false }),
    agent({ sessionId: 'ended', endedAt: '2026-11-14T10:00:00Z' }),
    agent({ sessionId: 'codex', harness: 'codex' }),
    agent({ sessionId: 'not ours', clickableLinks: null }),
  ];

  it('are the live Claude agents this daemon started the other way, worked out from the agents alone', () => {
    expect(startedOtherwise(agents, { clickableLinks: false, clickableLinksFromEnvironment: null }).map((a) => a.sessionId)).toEqual(['with']);
    expect(startedOtherwise(agents, { clickableLinks: true, clickableLinksFromEnvironment: null }).map((a) => a.sessionId)).toEqual(['without']);
  });

  it("are none before the settings are read, or while the user's own variable decides", () => {
    expect(startedOtherwise(agents, undefined)).toEqual([]);
    expect(startedOtherwise(agents, { clickableLinks: true, clickableLinksFromEnvironment: true })).toEqual([]);
  });
});

describe("restarting agents for the switch's change", () => {
  const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const api = (answer: (sessionId: string, force?: boolean) => Promise<RestartAgentResult>) => ({
    stop: vi.fn(async (sessionId: string) => agent({ sessionId })),
    restart: vi.fn(answer),
  });

  it('stops and restarts each one, asks about a busy shell, and goes on past a failure', async () => {
    const agents = api(async (sessionId) => {
      if (sessionId === 'b') return { status: 'busy', message: 'its shell is running something' };
      if (sessionId === 'c') throw new Error('gone');
      return { status: 'restarted', agent: agent({ sessionId }) };
    });
    const ada = agent({ sessionId: 'a', name: 'Ada' });
    const ben = agent({ sessionId: 'b', name: 'Ben' });
    const cy = agent({ sessionId: 'c', name: 'Cy' });
    expect(await restartForLinks([ada, ben, cy], agents, describeError)).toEqual({
      failed: ['Cy could not be restarted: gone'],
      asking: [{ sessionId: 'b', name: 'Ben', message: 'its shell is running something' }],
    });
    expect(agents.stop.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(agents.restart.mock.calls).toEqual([['a'], ['b'], ['c']]);
  });

  it("wakes a busy shell's agent anyway with force, and says when that fails", async () => {
    const shell = { sessionId: 'b', name: 'Ben', message: 'its shell is running something' };
    const woken = api(async (sessionId) => ({ status: 'restarted', agent: agent({ sessionId }) }));
    expect(await wakeAnyway(shell, woken, describeError)).toEqual({ asking: false });
    expect(woken.restart).toHaveBeenCalledWith('b', true);
    expect(await wakeAnyway(shell, api(async () => ({ status: 'busy', message: 'still' })), describeError)).toEqual({ asking: true });
    expect(
      await wakeAnyway(
        shell,
        api(async () => {
          throw new Error('gone');
        }),
        describeError,
      ),
    ).toEqual({ asking: false, problem: 'Ben could not be restarted: gone' });
  });

  it('says a cancelled one stays stopped', () => {
    expect(cancelledLine({ name: 'Ben' })).toBe('Ben is stopped: wake it from its tile.');
  });
});
