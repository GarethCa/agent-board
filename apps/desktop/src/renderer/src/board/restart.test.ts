import { describe, expect, it } from 'vitest';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { dismissedStill, restartBannerShown, restartMessage, stoppedByRestart } from './restart';

const agent = (sessionId: string, state: Agent['state']) => ({ sessionId, state }) as Agent;
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

  it('says how many, in the words of the machine it runs on', () => {
    expect(restartMessage(8, true)).toBe('8 sessions stopped when your Mac restarted');
    expect(restartMessage(1, false)).toBe('1 session stopped when your computer restarted');
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
