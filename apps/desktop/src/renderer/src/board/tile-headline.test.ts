import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, NeedsYouShows, PullRequest } from '@agent-board/daemon/protocol';
import { galleryAgent } from './TileGallery';
import { footerFoldKey, TILE_STATE_WORDS, tileAbout, tileButton, tileMark, tileMarkKey, tileNow, tileSince, tileState, tileTime, type TileState } from './tile-headline';

const NOW = Date.parse('2026-11-13T09:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const AT = ago(0);
const SHOWS: NeedsYouShows = 'explicit';
const status = (summary: string) => ({ summary, progress: null, updatedAt: AT, setBy: null });
const pr = (number: number, state: PullRequest['state'] = 'open'): PullRequest => ({ number, title: 'A change', url: '', state, checks: 'none' });
const base = (state: AgentState, fields: Partial<Agent> = {}): Agent => ({ ...galleryAgent(state), ...fields });
/** Its state on the tile, read from its own pill state. */
const stateOf = (agent: Agent) => tileState(agent, SHOWS, agent.state);

describe('what the tile says it is for', () => {
  it('is its purpose, over its issue’s title and its task', () => {
    expect(tileAbout(base('running', { purpose: 'Make the checkout test pass', description: 'Read CLAUDE.md first' }))).toBe('Make the checkout test pass');
  });

  it('falls back to its issue’s title, then its task’s first line', () => {
    const issue = { provider: 'linear', id: 'ABC-12', title: 'Fix the login', url: '' } as Agent['issue'];
    expect(tileAbout(base('running', { purpose: null, issue, description: 'Read CLAUDE.md first' }))).toBe('Fix the login');
    expect(tileAbout(base('running', { purpose: null, issue: null, description: '\n  Read CLAUDE.md first  \nThen fix it' }))).toBe('Read CLAUDE.md first');
  });

  it('is one line, and nothing when there is none of the three', () => {
    expect(tileAbout(base('running', { purpose: 'Two\nlines', issue: null }))).toBe('Two lines');
    expect(tileAbout(base('running', { purpose: null, issue: null, description: '' }))).toBeUndefined();
    expect(tileAbout(base('running', { purpose: '  ', issue: null, description: 'Its task' }))).toBe('Its task');
  });
});

describe('its state on the tile', () => {
  it('reads each of the seven from its record', () => {
    expect(stateOf(base('thinking'))).toBe('thinking');
    expect(stateOf(base('running'))).toBe('thinking');
    expect(stateOf(base('on-command'))).toBe('thinking');
    expect(stateOf(base('needs-permission', { permissions: [{ id: 'p', toolName: 'Bash', toolInput: {}, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: false, sessionGrant: null, dialog: null, plan: null, questions: null }] as Agent['permissions'] }))).toBe('needs-you');
    expect(stateOf(base('rate-limited'))).toBe('waiting');
    expect(stateOf(base('idle', { workCategory: { category: 'in-review', label: null, waitingOn: null, setAt: AT, setBy: null } }))).toBe('waiting');
    expect(stateOf(base('idle'))).toBe('idle');
    expect(stateOf(base('done'))).toBe('done');
    expect(stateOf(base('idle', { workFinishedAt: AT }))).toBe('done');
    expect(stateOf(base('hibernated'))).toBe('paused');
    expect(stateOf(base('failed'))).toBe('failed');
  });

  it('stays Needs you once seen: only its outline goes', () => {
    expect(stateOf(base('needs-permission', { seen: true, permissions: [{ id: 'p', toolName: 'Bash', toolInput: {}, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: false, sessionGrant: null, dialog: null, plan: null, questions: null }] as Agent['permissions'] }))).toBe('needs-you');
  });

  it('is Needs you for a flag to the user and a restart that stopped it', () => {
    expect(stateOf(base('idle', { flag: { id: 1, reason: 'Pick a cache', at: AT, to: 'user', via: null } }))).toBe('needs-you');
    expect(stateOf(base('stopped-by-restart'))).toBe('needs-you');
  });

  it('has a word for each', () => {
    expect(TILE_STATE_WORDS).toEqual({ thinking: 'Thinking', 'needs-you': 'Needs you', waiting: 'Waiting', idle: 'Idle', done: 'Done', paused: 'Paused', failed: 'Failed' });
  });
});

describe('what is true now', () => {
  const now = (state: TileState, fields: Partial<Agent> = {}) => tileNow(base('idle', fields), state);

  it('is its status line while it thinks, and nothing for its last turn’s message', () => {
    expect(now('thinking', { status: status('Renaming the spacing tokens'), lastMessage: 'Done before' })).toBe('Renaming the spacing tokens');
    expect(now('thinking', { status: null, lastMessage: 'Done before' })).toBeUndefined();
  });

  it('is the last line it said when idle or needing you, its status line first', () => {
    expect(now('idle', { status: null, lastMessage: 'Fixed it.\n\nAdded a Getting started section.\n' })).toBe('Added a Getting started section.');
    expect(now('idle', { status: status('Wrote the README'), lastMessage: 'Something else' })).toBe('Wrote the README');
    expect(now('needs-you', { status: null, lastMessage: 'Postgres or SQLite for the local cache?' })).toBe('Postgres or SQLite for the local cache?');
  });

  it('names a plan waiting for the user', () => {
    expect(now('needs-you', { plan: { title: 'Move the dock', decision: null } as unknown as Agent['plan'] })).toBe('Plan to review: Move the dock');
  });

  it('says what it waits on, in words', () => {
    const inReview = { category: 'in-review', label: null, waitingOn: null, setAt: AT, setBy: null } as const;
    expect(now('waiting', { workCategory: inReview, pullRequests: [pr(46)] })).toBe('Waits on its review · PR #46');
    expect(now('waiting', { workCategory: { ...inReview, category: 'waiting-on-others', waitingOn: { who: 'Northwind support', ref: '#48213' } } })).toBe('Waits on Northwind support · #48213');
    expect(now('waiting', { workCategory: { ...inReview, category: 'waiting-on-others', label: 'Legal' }, pullRequests: [] })).toBe('Waits on Legal');
    expect(now('waiting', { workCategory: { ...inReview, category: 'blocked', label: 'No API key' } })).toBe('Blocked · No API key');
    expect(tileNow(base('rate-limited'), 'waiting')).toBe('Waits on its usage limit');
    expect(tileNow(base('scheduled'), 'waiting')).toBe('Waits on its next run');
  });

  it('says it finished, and which pull request is ready', () => {
    expect(now('done', { pullRequests: [pr(44)] })).toBe('Finished · PR #44 is ready to review');
    expect(now('done', { pullRequests: [pr(44, 'merged')] })).toBe('Finished · PR #44 merged');
    expect(now('done', { pullRequests: [] })).toBe('Finished');
  });

  it('says a restart stopped it, and that Resume carries it on', () => {
    expect(tileNow(base('stopped-by-restart', { lastMessage: 'Half way' }), 'needs-you')).toBe('Stopped by a restart · Resume carries it on');
  });

  it('says what waking does, and what failed', () => {
    expect(now('paused')).toBe('Wake starts it where it left off.');
    expect(now('failed', { endedAt: AT, exitCode: 2, notice: null, lastMessage: null })).toBe('Ended · exit 2');
    expect(now('failed', { notice: '3 tests failed in checkout.spec.ts' })).toBe('3 tests failed in checkout.spec.ts');
    expect(now('failed', { notice: null, endedAt: null, lastMessage: null, status: null })).toBe('It failed');
  });
});

describe('the "some" clock', () => {
  const at = (minutes: number, state: TileState = 'needs-you') => tileTime(base('waiting', { stateSince: ago(minutes * MIN), hibernated: null, flag: null }), state, NOW);

  it('shows only on Needs you and Paused', () => {
    for (const state of ['thinking', 'waiting', 'idle', 'done', 'failed'] as const) expect(at(30, state)).toBeUndefined();
    expect(at(30, 'needs-you')).toBe('30 min');
    expect(at(30, 'paused')).toBe('30 min');
  });

  it('steps: just now under 5 minutes, then 5-minute steps, whole hours, then days', () => {
    expect(at(0)).toBe('just now');
    expect(at(4)).toBe('just now');
    expect(at(5)).toBe('5 min');
    expect(at(14)).toBe('10 min');
    expect(at(59)).toBe('55 min');
    expect(at(60)).toBe('1 h');
    expect(at(23 * 60 + 59)).toBe('23 h');
    expect(at(24 * 60)).toBe('1 d');
  });

  it('counts a pause from when it was paused, and a flag from when it was raised', () => {
    const paused = base('hibernated', { stateSince: ago(0), hibernated: { at: ago(3 * 60 * MIN), by: 'user' } as unknown as Agent['hibernated'] });
    expect(tileTime(paused, 'paused', NOW)).toBe('3 h');
    const flagged = base('idle', { stateSince: ago(0), flag: { id: 1, reason: 'Pick', at: ago(20 * MIN), to: 'user', via: null } });
    expect(tileTime(flagged, 'needs-you', NOW)).toBe('20 min');
  });

  it('counts from the moment its tooltip names', () => {
    const flagged = base('idle', { stateSince: ago(40 * MIN), flag: { id: 1, reason: 'Pick', at: ago(5 * MIN), to: 'user', via: null } });
    expect(tileSince(flagged, 'needs-you')).toBe(ago(5 * MIN));
    expect(tileSince(flagged, 'idle')).toBe(ago(40 * MIN));
  });

  it('says nothing for a time that doesn’t parse', () => {
    expect(tileTime(base('waiting', { stateSince: 'not a time', flag: null }), 'needs-you', NOW)).toBeUndefined();
  });
});

describe('its one button', () => {
  const button = (state: TileState, fields: Partial<Agent> = {}) => tileButton(base('idle', { pullRequests: [], ...fields }), state);

  it('is Open for Needs you or Failed, Review for Done with an open pull request, and Wake for Paused', () => {
    expect(button('needs-you')).toEqual({ kind: 'open', label: 'Open', prominent: true });
    expect(button('failed')).toEqual({ kind: 'open', label: 'Open', prominent: false });
    expect(button('done', { pullRequests: [pr(44)] })).toEqual({ kind: 'review', label: 'Review', prominent: false });
    expect(tileButton(base('hibernated'), 'paused')).toEqual({ kind: 'wake', label: 'Wake', prominent: false });
  });

  it('is none on Done with nothing to review: a merged or closed pull request, or none', () => {
    expect(button('done', { pullRequests: [pr(44, 'merged')] })).toBeUndefined();
    expect(button('done', { pullRequests: [pr(44, 'closed')] })).toBeUndefined();
    expect(button('done')).toBeUndefined();
  });

  it('is Wake, filled, for a paused agent that flags the user', () => {
    const flagged = base('hibernated', { flag: { id: 1, reason: 'Pick', at: AT, to: 'user', via: null } });
    expect(tileButton(flagged, stateOf(flagged))).toEqual({ kind: 'wake', label: 'Wake', prominent: true });
  });

  it('is none while it thinks, waits on others or is idle', () => {
    for (const state of ['thinking', 'waiting', 'idle'] as const) expect(button(state)).toBeUndefined();
  });
});

describe('its mark, which the footer folds round', () => {
  it('changes when a finished turn comes to need the user, with no change to its state', () => {
    const finished = base('waiting', { ask: null, flag: null, plan: null, permissions: [], stepsWait: null, ledBy: null });
    const quiet = tileMark(finished, 'explicit', false, false);
    expect(quiet.state).toBe('idle');
    expect(quiet.button).toBeUndefined();
    // Needs you comes to list finished turns: the same record now needs the user, and gets its Open button.
    const listed = tileMark(finished, 'turns', false, false);
    expect(listed.state).toBe('needs-you');
    expect(listed.button?.label).toBe('Open');
    expect(tileMarkKey(listed)).not.toBe(tileMarkKey(quiet));
  });

  it('changes when its waiting is seen: the pill loses the needs-you look', () => {
    const asking = base('waiting', { ledBy: null, seen: false });
    const seen = { ...asking, seen: true };
    expect(tileMarkKey(tileMark(seen, 'turns', false, false))).not.toBe(tileMarkKey(tileMark(asking, 'turns', false, false)));
  });

  it('has no button while it hands work on or takes it in', () => {
    const asking = base('waiting', { ledBy: null });
    expect(tileMark(asking, 'turns', true, false).pill.state).toBe('handing-off');
    expect(tileMark(asking, 'turns', true, false).button).toBeUndefined();
    expect(tileMark(asking, 'turns', false, true).button).toBeUndefined();
  });

  it('is in the footer\'s fold key: the same footer measures again when only its mark changes', () => {
    const finished = base('waiting', { ask: null, flag: null, plan: null, permissions: [], stepsWait: null, ledBy: null });
    const line = [['#34', '#41'], 0, 'waiting'];
    const parts = { mark: tileMark(finished, 'explicit', false, false), statePill: true, age: undefined, stateTime: undefined, character: 'off', onCredits: false };
    const key = footerFoldKey(line, parts);
    expect(footerFoldKey(line, { ...parts, mark: tileMark(finished, 'turns', false, false) })).not.toBe(key);
    // The pill or the word and its time: the state-pill tile part switches between them.
    expect(footerFoldKey(line, { ...parts, statePill: false })).not.toBe(key);
    expect(footerFoldKey(line, { ...parts, age: '2m' })).not.toBe(key);
    expect(footerFoldKey(line, { ...parts, stateTime: '3m' })).not.toBe(key);
    expect(footerFoldKey(line, { ...parts })).toBe(key);
  });
});
