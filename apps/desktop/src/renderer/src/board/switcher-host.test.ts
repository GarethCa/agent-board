import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { PullRequestSurface, Surface } from '@agent-board/daemon/window-layout';
import type { ReviewedPullRequest } from '../review/reviews';
import { boardOpening, switcherPick, type SwitcherBoard } from './switcher-host';

const agent = (sessionId: string, more: Partial<Agent> = {}): Agent => ({ sessionId, pullRequests: [], pushedPullRequests: [], ...more }) as Agent;
const pr: PullRequestSurface = { kind: 'pr', repo: 'Acme/App', number: 7 };
const web: Surface = { kind: 'web', id: 'w', url: 'https://example.com' };
const sessionOf = (id: string): Surface => ({ kind: 'session', target: { kind: 'agent', id } });

describe('whose window a pick on the board opens in', () => {
  const owner = agent('a', { pullRequests: [{ url: 'https://github.com/acme/app/pull/7' } as Agent['pullRequests'][number]] });
  const pusher = agent('p', { pushedPullRequests: [{ url: 'https://github.com/acme/app/pull/7' } as Agent['pullRequests'][number]] });
  const selected = agent('s');
  const reviewer = agent('r');
  const reviewed = new Map<string, ReviewedPullRequest>([['r', { surface: pr, status: 'ready', findings: 3 }]]);
  const board = (more: Partial<SwitcherBoard> = {}): SwitcherBoard => ({ agents: [selected, owner, pusher, reviewer], selected: undefined, beside: false, reviewed, ...more });
  const hostOf = (surface: Surface, more: Partial<SwitcherBoard> = {}) => switcherPick(surface, board(more))?.host.sessionId;

  it("opens a pull request in its agent's window, alone or with nothing selected", () => {
    expect(switcherPick(pr, board({ selected: 's' }))).toEqual({ host: owner, surface: pr });
    expect(hostOf(pr, { beside: true })).toBe('a');
    expect(hostOf(pr, { agents: [pusher] })).toBe('p');
  });

  it("opens a pull request beside the agent selected, even one another agent opened, so a reviewer's findings sit beside it", () => {
    expect(switcherPick(pr, board({ selected: 's', beside: true }))).toEqual({ host: selected, surface: pr });
    expect(hostOf(pr, { selected: 'a', beside: true })).toBe('a');
  });

  it('opens anything beside the agent selected', () => {
    expect(switcherPick(web, board({ selected: 's', beside: true }))).toEqual({ host: selected, surface: web });
    expect(hostOf(sessionOf('b'), { agents: [selected, agent('b')], selected: 's', beside: true })).toBe('s');
  });

  it('opens a reviewer beside in its own window, with the pull request it reviews beside it, whatever is selected', () => {
    expect(switcherPick(sessionOf('r'), board({ beside: true }))).toEqual({ host: reviewer, surface: pr });
    expect(switcherPick(sessionOf('r'), board({ selected: 's', beside: true }))).toEqual({ host: reviewer, surface: pr });
    expect(switcherPick(sessionOf('r'), board({ selected: 'r', beside: true }))).toEqual({ host: reviewer, surface: pr });
    expect(switcherPick(sessionOf('r'), board())).toBeUndefined();
  });

  it('has none for a page no agent holds, opened alone, or with nothing selected', () => {
    expect(switcherPick(web, board({ selected: 's' }))).toBeUndefined();
    expect(switcherPick({ kind: 'pr', repo: 'acme/app', number: 8 }, board({ beside: true }))).toBeUndefined();
  });

  it('never opens an agent beside itself', () => {
    expect(switcherPick(sessionOf('s'), board({ selected: 's', beside: true }))).toBeUndefined();
  });
});

describe('what a pick on the board opens', () => {
  const owner = agent('a', { pullRequests: [{ url: 'https://github.com/acme/app/pull/7' } as Agent['pullRequests'][number]] });
  const selected = agent('s');
  const board = (more: Partial<SwitcherBoard> = {}): SwitcherBoard => ({ agents: [selected, owner], selected: undefined, beside: false, reviewed: new Map(), ...more });
  const nonePoppedOut = () => false;

  it("opens the host's window, with the pick asked of it", () => {
    expect(boardOpening(pr, board(), nonePoppedOut)).toEqual({ opens: 'window', host: owner, surface: pr });
    expect(boardOpening(web, board({ selected: 's', beside: true }), nonePoppedOut)).toEqual({ opens: 'window', host: selected, surface: web });
  });

  it('opens a pull request or page no window can take in a tab window of its own', () => {
    expect(boardOpening({ kind: 'pr', repo: 'acme/app', number: 8 }, board(), nonePoppedOut)).toEqual({ opens: 'tab-window' });
    expect(boardOpening(web, board({ selected: 's' }), nonePoppedOut)).toEqual({ opens: 'tab-window' });
  });

  it("opens a tab window when the host's window is popped out, since another renderer can't hear the tab asked for", () => {
    expect(boardOpening(pr, board(), (sessionId) => sessionId === 'a')).toEqual({ opens: 'tab-window' });
  });

  it('leaves a session with no host to the board', () => {
    expect(boardOpening(sessionOf('b'), board(), nonePoppedOut)).toEqual({ opens: 'nothing' });
    expect(boardOpening(sessionOf('b'), board({ selected: 's', beside: true }), (sessionId) => sessionId === 's')).toEqual({ opens: 'nothing' });
  });
});
