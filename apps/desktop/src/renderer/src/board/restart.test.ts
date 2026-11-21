import { describe, expect, it } from 'vitest';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import {
  carryOn,
  cutOffBack,
  dismissedStill,
  restartBannerShown,
  restartIds,
  restartMessage,
  restartPassRunning,
  stoppedByRestart,
  undismissed,
  wakeAll,
} from './restart';

const agent = (sessionId: string, state: Agent['state'], cutOffMidTurn = false, cutOffAsking = false) => ({ sessionId, state, cutOffMidTurn, cutOffAsking }) as Agent;
const ids = (woken: { agents: Agent[]; shells: Shell[] } | null) => woken === null ? [] : [...woken.agents.map((each) => each.sessionId), ...woken.shells.map((each) => each.id)];
const shell = (id: string, stoppedPanes: string[]) => ({ id, stoppedPanes }) as Shell;

describe('sessions stopped by a restart', () => {
  it('finds the agents and the shells with panes a restart stopped', () => {
    const stopped = stoppedByRestart(
      [agent('a', 'stopped-by-restart'), agent('b', 'failed'), agent('c', 'stopped-by-restart')],
      [shell('s', ['p1', 'p2']), shell('t', [])],
    );

    expect(stopped.agents.map((each) => each.sessionId)).toEqual(['a', 'c']);
    expect(stopped.shells.map((each) => each.id)).toEqual(['s']);
    expect(stopped.ids).toEqual(['a', 'c', 'p1', 'p2']);
    expect(stoppedByRestart([], undefined).ids).toEqual([]);
  });

  it('says how many stopped and how many were working, in the words of the machine it runs on', () => {
    const working = (n: number) => Array.from({ length: n }, (_, i) => agent(`w${i}`, 'stopped-by-restart', true));
    const idle = (n: number) => Array.from({ length: n }, (_, i) => agent(`i${i}`, 'stopped-by-restart'));
    expect(restartMessage(stoppedByRestart([...working(3), ...idle(5)], []), true)).toBe('8 sessions stopped when your Mac restarted · 3 were working');
    expect(restartMessage(stoppedByRestart(working(1), []), false)).toBe('1 session stopped when your computer restarted · 1 was working');
    expect(restartMessage(stoppedByRestart(idle(2), []), true)).toBe('2 sessions stopped when your Mac restarted · none was working');
  });

  it('names the shells Wake all reopens, so it never wakes what the banner left unsaid', () => {
    const stopped = stoppedByRestart([agent('idle', 'stopped-by-restart')], [shell('s', ['p1'])]);
    expect(restartMessage(stopped, true)).toBe('2 sessions stopped when your Mac restarted · none was working, 1 shell');
    expect(ids(wakeAll(stopped))).toEqual(['s']);
    const two = stoppedByRestart([agent('w', 'stopped-by-restart', true)], [shell('s', ['p1']), shell('t', ['p2', 'p3'])]);
    expect(restartMessage(two, true)).toBe('4 sessions stopped when your Mac restarted · 1 was working, 2 shells');
  });

  it('wakes with Wake all only the agents that were mid-turn when the app stopped', () => {
    const stopped = stoppedByRestart(
      [agent('working', 'stopped-by-restart', true), agent('idle', 'stopped-by-restart'), agent('paused', 'hibernated', true), agent('live', 'running', true)],
      [],
    );

    expect(ids(wakeAll(stopped))).toEqual(['working']);
  });

  it('leaves asleep an agent a restart cut off on a permission prompt: it was asking, not working', () => {
    const stopped = stoppedByRestart([agent('asking', 'stopped-by-restart', true, true), agent('working', 'stopped-by-restart', true)], []);

    expect(ids(wakeAll(stopped))).toEqual(['working']);
    expect(restartMessage(stopped, true)).toBe('2 sessions stopped when your Mac restarted · 1 was working');
  });

  it('takes an agent from an older daemon, which does not say, for one that was not working', () => {
    const older = { sessionId: 'old', state: 'stopped-by-restart' } as Agent;

    expect(wakeAll(stoppedByRestart([older], []))).toBeNull();
  });

  it('has nothing for Wake all when nothing was working and no shell stopped', () => {
    expect(wakeAll(stoppedByRestart([agent('idle', 'stopped-by-restart')], []))).toBeNull();
  });

  it('shows the banner while any stopped session is one the user has not dismissed it for', () => {
    expect(restartBannerShown(['a', 'b'], ['a'])).toBe(true);
    expect(restartBannerShown(['a'], ['a', 'b'])).toBe(false);
    expect(restartBannerShown([], [])).toBe(false);
  });

  it('forgets a dismissal once its session is no longer stopped, so a later restart that stops it shows the banner again', () => {
    // Dismissed for A and B; then A was resumed.
    const dismissed = dismissedStill(['a', 'b'], ['b']);
    expect(dismissed).toEqual(['b']);
    // A later restart stops A again.
    expect(restartBannerShown(['a', 'b'], dismissed)).toBe(true);
  });
});

describe('agents the daemon brought back after a restart', () => {
  /** An agent the daemon's start brought back, live at its prompt. */
  const back = (sessionId: string, cutOffMidTurn = false, cutOffAsking = false) =>
    ({ sessionId, state: 'idle', endedAt: null, backAfterRestart: true, cutOffMidTurn, cutOffAsking }) as Agent;

  it('waits while the daemon is still bringing any of them back', () => {
    const coming = { sessionId: 'c', state: 'stopped-by-restart', endedAt: '2026-11-20', comingBackAfterRestart: true } as Agent;
    expect(restartPassRunning([back('a'), coming])).toBe(true);
    expect(restartPassRunning([back('a'), { ...coming, comingBackAfterRestart: false }])).toBe(false);
  });

  it('says how many came back, how many of those were cut off mid-turn, and how many stayed stopped', () => {
    const agents = [back('a'), back('b', true), back('c', true), agent('d', 'stopped-by-restart')];
    expect(restartMessage(stoppedByRestart(agents, []), true, agents)).toBe('3 came back after the restart · 2 were cut off mid-turn · 1 stayed stopped');
    const one = [back('a', true)];
    expect(restartMessage(stoppedByRestart(one, []), true, one)).toBe('1 came back after the restart · 1 was cut off mid-turn');
  });

  it('offers Carry on to the ones cut off mid-turn only: not one idle, nor one on a permission prompt, nor one not brought back', () => {
    const agents = [back('idle'), back('cut', true), back('asking', true, true), agent('stopped', 'stopped-by-restart', true), { ...back('ended', true), endedAt: '2026-11-20' }];

    expect(cutOffBack(agents).map((each) => each.sessionId)).toEqual(['cut']);
  });

  it('shows no banner once all came back with none cut off, and one while some wait to carry on', () => {
    const all = [back('a'), back('b')];
    expect(restartBannerShown(restartIds(stoppedByRestart(all, []), cutOffBack(all)), [])).toBe(false);
    const some = [back('a'), back('b', true)];
    expect(restartIds(stoppedByRestart(some, []), cutOffBack(some))).toEqual(['b']);
    // Once told to carry on, it is no longer cut off: its dismissal is forgotten with it.
    expect(dismissedStill(['b'], restartIds(stoppedByRestart(all, []), cutOffBack(all)))).toEqual([]);
  });

  it('carries on with Carry on only the cut-off ones it is given, waking none still stopped, and settles with those told', async () => {
    const told: string[] = [];
    const tell = async (sessionId: string) => {
      told.push(sessionId);
      // The user is typing at this one: it keeps its Carry on.
      return sessionId !== 'typing';
    };
    const agents = [back('cut', true), back('typing', true), agent('old', 'stopped-by-restart', true)];

    await expect(carryOn(cutOffBack(agents), tell)).resolves.toEqual(['cut']);
    expect(told).toEqual(['cut', 'typing']);
  });

  it('counts as stayed stopped, and wakes with Wake all, only what the user has not dismissed, so an earlier restart is left be', () => {
    const agents = [back('a'), agent('old', 'stopped-by-restart', true), agent('new', 'stopped-by-restart', true)];
    const shown = undismissed(stoppedByRestart(agents, [shell('s', ['p1']), shell('t', ['p2'])]), ['old', 'p2']);

    expect(restartMessage(shown, true, agents)).toBe('1 came back after the restart · 2 stayed stopped');
    expect(ids(wakeAll(shown))).toEqual(['new', 's']);
  });
});
