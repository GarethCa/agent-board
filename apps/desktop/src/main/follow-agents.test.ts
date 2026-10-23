import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentState, DaemonEvent, DaemonSettings } from '@agent-board/daemon/protocol';
import type { AgentAlerts } from './alerts';
import { followAgents, type FollowedLink } from './follow-agents';

const agent = (sessionId: string, state: AgentState) => ({ sessionId, state }) as Agent;

const SETTINGS = { needsYouShows: 'explicit', notifications: true, notifyInFront: false } as DaemonSettings;

/**
 * A daemon link whose `agent.list` answers from `listings` in turn (an Error rejects), and its `settings.get` with
 * `SETTINGS`, and that connects on a call when it is not connected, as the real link does. `calls` are its listings.
 */
function fakeLink(listings: (Agent[] | Error)[]) {
  const events = new Set<(event: DaemonEvent) => void>();
  const connected = new Set<() => void>();
  const disconnected = new Set<() => void>();
  let up = false;
  const calls: string[] = [];
  const link: FollowedLink = {
    call: (async (method: string) => {
      if (method === 'settings.get') return SETTINGS;
      calls.push(method);
      if (!up) {
        up = true;
        for (const listener of connected) listener();
      }
      const next = listings.shift();
      if (next === undefined) throw new Error('no listing left');
      if (next instanceof Error) throw next;
      return next;
    }) as FollowedLink['call'],
    onEvent: (listener) => (events.add(listener), () => events.delete(listener)),
    onConnected: (listener) => (connected.add(listener), () => connected.delete(listener)),
    onDisconnected: (listener) => (disconnected.add(listener), () => disconnected.delete(listener)),
  };
  return {
    link,
    calls,
    emit: (event: DaemonEvent) => events.forEach((listener) => listener(event)),
    drop() {
      up = false;
      disconnected.forEach((listener) => listener());
    },
  };
}

function recordingAlerts() {
  const log: unknown[] = [];
  const alerts: AgentAlerts = {
    reset: (agents, settings) => log.push(['reset', agents.map((a) => a.sessionId), settings?.needsYouShows]),
    updated: (a) => log.push(['updated', a.sessionId]),
    removed: (sessionId) => log.push(['removed', sessionId]),
    settingsChanged: (settings) => log.push(['settings', settings.needsYouShows]),
  };
  return { alerts, log };
}

const RETRY = [100, 200, 400];

describe('following the agents', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists the agents and reads the settings once at start, then follows their events', async () => {
    const { link, calls, emit } = fakeLink([[agent('a', 'idle')]]);
    const { alerts, log } = recordingAlerts();

    followAgents(link, alerts, RETRY);
    await vi.runAllTimersAsync();
    emit({ type: 'agent.updated', agent: agent('a', 'waiting') });
    emit({ type: 'agent.removed', sessionId: 'a' });
    emit({ type: 'settings.updated', settings: { ...SETTINGS, needsYouShows: 'turns' } });

    // One listing, though the call that made it also connected the link.
    expect(calls).toEqual(['agent.list']);
    expect(log).toEqual([['reset', ['a'], 'explicit'], ['updated', 'a'], ['removed', 'a'], ['settings', 'turns']]);
  });

  it('retries a failed listing, backing off, until one succeeds', async () => {
    const { link, calls } = fakeLink([new Error('down'), new Error('down'), [agent('a', 'idle')]]);
    const { alerts, log } = recordingAlerts();

    followAgents(link, alerts, RETRY);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);

    expect(calls).toHaveLength(3);
    expect(log).toEqual([['reset', ['a'], 'explicit']]);
  });

  it('reconnects after a drop, without waiting for anything else to call, and lists the agents again', async () => {
    const { link, calls, drop } = fakeLink([[agent('a', 'idle')], [agent('a', 'waiting'), agent('b', 'idle')]]);
    const { alerts, log } = recordingAlerts();
    followAgents(link, alerts, RETRY);
    await vi.runAllTimersAsync();

    drop();
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toEqual(['agent.list', 'agent.list']);
    expect(log).toEqual([['reset', ['a'], 'explicit'], ['reset', ['a', 'b'], 'explicit']]);
  });

  it('lists the agents again when something else reconnects the link first', async () => {
    const { link, calls, drop } = fakeLink([[agent('a', 'idle')], [agent('a', 'done')], []]);
    const { alerts, log } = recordingAlerts();
    followAgents(link, alerts, RETRY);
    await vi.runAllTimersAsync();
    drop();

    // The renderer calls before the retry is due: the new connection is listed at once, and the retry is not needed.
    await link.call('agent.list');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['agent.list', 'agent.list', 'agent.list']);
    expect(log).toEqual([['reset', ['a'], 'explicit'], ['reset', ['a'], 'explicit']]);
  });

  it('stops retrying once stopped', async () => {
    const { link, calls } = fakeLink([new Error('closed')]);
    const { alerts } = recordingAlerts();

    const stop = followAgents(link, alerts, RETRY);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toHaveLength(1);
  });

  it('keeps retrying at the longest delay', async () => {
    const { link, calls } = fakeLink(Array.from({ length: 6 }, () => new Error('down')));
    const { alerts } = recordingAlerts();

    followAgents(link, alerts, RETRY);
    await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 400 + 400);

    expect(calls).toHaveLength(6);
  });
});
