import { describe, expect, it } from 'vitest';
import type { Agent, LinkedIssue } from '@agent-board/daemon/protocol';
import {
  branchSaysMore,
  calmTimes,
  FULL_TILE,
  PARTS_TO_TURN_ON,
  pillShowsAge,
  QUIET_TILE,
  sinceLabel,
  stateAge,
  tileDetails,
  tileProgress,
  tileShowsFrom,
  tileShowsWith,
  timeToGo,
  toGoChangesIn,
  type TileShows,
} from './tile-shows';

const NOW = Date.parse('2026-11-11T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const issue = { provider: 'linear', id: 'ABC-12', title: 'Fix the login', url: 'https://example.com/ABC-12' } as LinkedIssue;
const agent = (fields: Partial<Agent> = {}) =>
  ({ branch: 'abc-12-fix-login', reviews: null, issue, trustedByZone: false, status: null, ...fields }) as Agent;

describe('the time in its state', () => {
  it('says nothing for its first minute', () => {
    expect(stateAge(ago(0), NOW)).toBeUndefined();
    expect(stateAge(ago(59_000), NOW)).toBeUndefined();
  });

  it('says minutes, then hours, then days', () => {
    expect(stateAge(ago(3 * MIN), NOW)).toBe('3m');
    expect(stateAge(ago(59 * MIN + 59_000), NOW)).toBe('59m');
    expect(stateAge(ago(60 * MIN), NOW)).toBe('1h');
    expect(stateAge(ago(23 * 60 * MIN + 59 * MIN), NOW)).toBe('23h');
    expect(stateAge(ago(50 * 60 * MIN), NOW)).toBe('2d');
  });

  it("says on its pill's tooltip since when, with its day once that is not today", () => {
    expect(sinceLabel(ago(5 * MIN), NOW)).toMatch(/^since \d\d:\d\d$/);
    expect(sinceLabel(ago(2 * 24 * 60 * MIN), NOW)).toMatch(/^since Mon \d\d:\d\d$/);
    expect(sinceLabel(ago(30 * 24 * 60 * MIN), NOW)).toMatch(/^since 12 Oct \d\d:\d\d$/);
  });

  it('says nothing for a time that does not parse', () => {
    expect(stateAge('not a time', NOW)).toBeUndefined();
  });

  it('is on the pill but while paused, starting or handing off', () => {
    expect(pillShowsAge('running')).toBe(true);
    expect(pillShowsAge('needs-permission')).toBe(true);
    expect(pillShowsAge('idle')).toBe(true);
    expect(pillShowsAge('hibernated')).toBe(false);
    expect(pillShowsAge('starting')).toBe(false);
    expect(pillShowsAge('handing-off')).toBe(false);
  });
});

describe("the Simplified tile's times", () => {
  const schedule = (fields: Partial<NonNullable<Agent['schedule']>> = {}) =>
    ({ clockId: 'c', cron: '0 9 * * *', prompt: 'go', enabled: true, nextRunAt: new Date(NOW + 130 * MIN).toISOString(), lastRun: null, hibernates: false, ...fields }) as Agent['schedule'];
  const calm = (fields: Partial<Agent>) => ({ state: 'running', stateSince: ago(12 * MIN), schedule: null, ...fields }) as Agent;

  it('says how long it has been in its state, in words', () => {
    expect(calmTimes(calm({}), NOW, QUIET_TILE)).toBe('12 min');
    expect(calmTimes(calm({ stateSince: ago(3 * 60 * MIN) }), NOW, QUIET_TILE)).toBe('3 h');
    expect(calmTimes(calm({ stateSince: ago(30_000) }), NOW, QUIET_TILE)).toBeUndefined();
    expect(calmTimes(calm({ state: 'hibernated' }), NOW, QUIET_TILE)).toBeUndefined();
  });

  it('adds its next run while its schedule is on', () => {
    expect(calmTimes(calm({ schedule: schedule() }), NOW, QUIET_TILE)).toBe('12 min · next run in 2 h 10 m');
    expect(calmTimes(calm({ state: 'hibernated', schedule: schedule() }), NOW, QUIET_TILE)).toBe('next run in 2 h 10 m');
    expect(calmTimes(calm({ schedule: schedule({ enabled: false, nextRunAt: null }) }), NOW, QUIET_TILE)).toBe('12 min');
  });

  it('says neither with every part shown as before', () => {
    expect(calmTimes(calm({ schedule: schedule() }), NOW, FULL_TILE)).toBeUndefined();
  });
});

describe('the next wake in words', () => {
  const at = (ms: number) => new Date(NOW + ms);
  it('says minutes, hours and minutes, then days', () => {
    expect(timeToGo(at(30_000), new Date(NOW))).toBe('in 1 m');
    expect(timeToGo(at(5 * MIN), new Date(NOW))).toBe('in 5 m');
    expect(timeToGo(at(130 * MIN), new Date(NOW))).toBe('in 2 h 10 m');
    expect(timeToGo(at(120 * MIN), new Date(NOW))).toBe('in 2 h');
    expect(timeToGo(at(3 * 24 * 60 * MIN), new Date(NOW))).toBe('in 3 d');
  });

  it('counts whole days, as it counts whole hours', () => {
    expect(timeToGo(at(36 * 60 * MIN), new Date(NOW))).toBe('in 1 d');
    expect(timeToGo(at(47 * 60 * MIN + 59 * MIN), new Date(NOW))).toBe('in 1 d');
    expect(timeToGo(at(48 * 60 * MIN), new Date(NOW))).toBe('in 2 d');
  });

  it('is read again just as it would read differently, and once a minute once due', () => {
    const next = at(130 * MIN + 15_000).toISOString();
    expect(toGoChangesIn(next, NOW)).toBe(15_000);
    expect(timeToGo(new Date(next), new Date(NOW + 14_999))).toBe('in 2 h 11 m');
    expect(timeToGo(new Date(next), new Date(NOW + 15_000))).toBe('in 2 h 10 m');
    expect(toGoChangesIn(at(120 * MIN).toISOString(), NOW)).toBe(60_000);
    expect(toGoChangesIn(at(-5 * MIN).toISOString(), NOW)).toBe(60_000);
  });

  it('says its date a week or more away', () => {
    expect(timeToGo(at(10 * 24 * 60 * MIN), new Date(NOW))).toMatch(/^21 Nov \d\d:00$/);
  });

  it('says due now once its time has come', () => {
    expect(timeToGo(at(0), new Date(NOW))).toBe('due now');
    expect(timeToGo(at(-5 * MIN), new Date(NOW))).toBe('due now');
  });
});

describe('the progress hairline', () => {
  const working = (fields: Partial<Agent>, progress: number | null) =>
    ({ state: 'running', status: { summary: 'Migrating', progress, updatedAt: ago(0), setBy: null }, ...fields }) as Agent;

  it('shows how far through it says it is while it is at work, kept within 0 to 100', () => {
    expect(tileProgress(working({}, 40), QUIET_TILE)).toBe(40);
    expect(tileProgress(working({ state: 'thinking' }, 40), QUIET_TILE)).toBe(40);
    expect(tileProgress(working({ state: 'on-command' }, 40), QUIET_TILE)).toBe(40);
    expect(tileProgress(working({}, 140), QUIET_TILE)).toBe(100);
    expect(tileProgress(working({}, -5), QUIET_TILE)).toBe(0);
  });

  it('shows nothing with no progress, nor once it stops work, nor with every part shown as before', () => {
    expect(tileProgress(working({}, null), QUIET_TILE)).toBeUndefined();
    expect(tileProgress({ state: 'running', status: null } as Agent, QUIET_TILE)).toBeUndefined();
    for (const state of ['idle', 'waiting', 'needs-permission', 'hibernated', 'scheduled', 'done'] as const) {
      expect(tileProgress(working({ state }, 100), QUIET_TILE)).toBeUndefined();
    }
    expect(tileProgress(working({}, 40), FULL_TILE)).toBeUndefined();
  });
});

describe('the branch row', () => {
  it('says nothing new for a branch named for its issue', () => {
    expect(branchSaysMore(agent())).toBe(false);
    expect(branchSaysMore(agent({ branch: 'abc-12' }))).toBe(false);
    expect(branchSaysMore(agent({ branch: 'dev/ABC-12-fix-login' }))).toBe(false);
  });

  it('says something when the branch differs from its issue, or it has no issue', () => {
    expect(branchSaysMore(agent({ branch: 'abc-120-other' }))).toBe(true);
    expect(branchSaysMore(agent({ branch: 'spike-login' }))).toBe(true);
    expect(branchSaysMore(agent({ issue: null }))).toBe(true);
  });

  it('says nothing with no branch, and always what a reviewer reviews', () => {
    expect(branchSaysMore(agent({ branch: '', issue: null }))).toBe(false);
    expect(branchSaysMore(agent({ reviews: { branch: 'abc-12-fix-login', head: 'abcdef1234' } }))).toBe(true);
  });
});

describe('the hover card’s details', () => {
  const setBy = { summary: 'Merging', progress: null, updatedAt: ago(0), setBy: 'release-lead' };

  it('holds what the quiet tile leaves off', () => {
    expect(tileDetails(agent({ trustedByZone: true, status: setBy }), QUIET_TILE, false)).toEqual([
      'Branch: abc-12-fix-login',
      'Status set by release-lead',
      "Trusted by its zone's setting: Claude's trust screen was answered by that setting, not by you",
    ]);
  });

  it('leads with what the agent says it is for, whatever the look', () => {
    expect(tileDetails(agent({ purpose: 'Hooks go quiet outside work hours' }), FULL_TILE, true)).toEqual(['For: Hooks go quiet outside work hours']);
  });

  it('holds nothing the tile already shows', () => {
    expect(tileDetails(agent({ trustedByZone: true, status: setBy }), FULL_TILE, true)).toEqual([]);
    expect(tileDetails(agent({ branch: '' }), QUIET_TILE, false)).toEqual([]);
  });
});

describe('the tile look as saved', () => {
  it('is the quiet tile when nothing was saved, or what was saved is not a look', () => {
    expect(tileShowsFrom(undefined)).toBe(QUIET_TILE);
    expect(tileShowsFrom(null)).toBe(QUIET_TILE);
    expect(tileShowsFrom('full')).toBe(QUIET_TILE);
    expect(tileShowsFrom([true])).toBe(QUIET_TILE);
  });

  it('turns back on the parts saved on, and keeps the rest quiet', () => {
    expect(tileShowsFrom({ branchAlways: true, mutedInFooter: true })).toEqual({ ...QUIET_TILE, branchAlways: true, mutedInFooter: true });
    expect(tileShowsFrom({ ...FULL_TILE })).toEqual(FULL_TILE);
  });

  it('reads only the parts it knows, each a yes or no', () => {
    expect(tileShowsFrom({ setBy: 'yes', trusted: 1, cornerAlways: true, sparkles: true })).toEqual({ ...QUIET_TILE, cornerAlways: true });
  });

  it('is the quiet tile itself when what was saved says the same', () => {
    expect(tileShowsFrom({ ...QUIET_TILE })).toBe(QUIET_TILE);
  });
});

describe('the switches that turn parts back on', () => {
  it('are one for each part the quiet tile leaves off, and none for what it adds', () => {
    const leftOff = (Object.keys(QUIET_TILE) as (keyof TileShows)[]).filter((part) => !QUIET_TILE[part]);
    expect(PARTS_TO_TURN_ON.map((each) => each.part).sort()).toEqual([...leftOff].sort());
    expect(leftOff).toHaveLength(6);
  });

  it('change one part and keep the others as they were', () => {
    const some = tileShowsWith(QUIET_TILE, 'setBy', true);
    expect(some).toEqual({ ...QUIET_TILE, setBy: true });
    expect(tileShowsWith(some, 'trusted', true)).toEqual({ ...QUIET_TILE, setBy: true, trusted: true });
    expect(tileShowsWith(FULL_TILE, 'branchAlways', false)).toEqual({ ...FULL_TILE, branchAlways: false });
  });

  it('give back the quiet tile itself once every part is off again', () => {
    expect(tileShowsWith(tileShowsWith(QUIET_TILE, 'setBy', true), 'setBy', false)).toBe(QUIET_TILE);
  });
});
