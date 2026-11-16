import { describe, expect, it } from 'vitest';
import { issueZoneOf, repoZoneOf } from '../src/repo-zone.ts';

const zone = (id: string, repoRoot: string | null, hasTracker = false, createdAt = '2026-10-10T00:00:00.000Z') => ({
  id,
  repoRoot,
  hasTracker,
  createdAt,
});

describe("an agent's repo zone", () => {
  const zones = [zone('other', '/code/other', true), zone('plain', '/code/app'), zone('tracked', '/code/app', true), zone('ideas', null)];

  it('is the zone it sits in, when that is of its repo', () => {
    expect(repoZoneOf({ zoneId: 'plain', repoRoot: '/code/app' }, zones)?.id).toBe('plain');
  });

  it('is a zone of its repo with a tracker, else any zone of its repo, when it sits elsewhere or loose', () => {
    expect(repoZoneOf({ zoneId: 'other', repoRoot: '/code/app' }, zones)?.id).toBe('tracked');
    expect(repoZoneOf({ zoneId: 'ideas', repoRoot: '/code/app' }, zones)?.id).toBe('tracked');
    expect(repoZoneOf({ zoneId: null, repoRoot: '/code/app' }, zones)?.id).toBe('tracked');
    expect(repoZoneOf({ zoneId: null, repoRoot: '/code/app' }, [zone('plain', '/code/app')])?.id).toBe('plain');
  });

  it('takes the oldest zone, then the lowest id, whatever order the zones come in', () => {
    const late = zone('a-late', '/code/app', true, '2026-10-10T00:00:02.000Z');
    const early = zone('z-early', '/code/app', true, '2026-10-10T00:00:01.000Z');
    const tie = zone('b-tie', '/code/app', true, '2026-10-10T00:00:01.000Z');
    expect(repoZoneOf({ zoneId: null, repoRoot: '/code/app' }, [late, early])?.id).toBe('z-early');
    expect(repoZoneOf({ zoneId: null, repoRoot: '/code/app' }, [late, early, tie])?.id).toBe('b-tie');
  });

  it('is none when no zone is of its repo', () => {
    expect(repoZoneOf({ zoneId: 'other', repoRoot: '/code/gone' }, zones)).toBeUndefined();
  });

  it('is the group with a tracker it sits in, when no zone of its repo has a tracker', () => {
    const group = zone('planning', null, true);
    expect(repoZoneOf({ zoneId: 'planning', repoRoot: '/code/gone' }, [...zones, group])?.id).toBe('planning');
    expect(repoZoneOf({ zoneId: 'planning', repoRoot: '/code/app' }, [...zones, group])?.id).toBe('tracked');
    expect(repoZoneOf({ zoneId: 'planning', repoRoot: '/code/app' }, [zone('plain', '/code/app'), group])?.id).toBe('planning');
    expect(repoZoneOf({ zoneId: 'ideas', repoRoot: '/code/gone' }, zones)).toBeUndefined();
  });
});

describe("the zone a new agent's issue is read from", () => {
  const tracked = (id: string, repoRoot: string | null, scope: string, createdAt = '2026-10-10T00:00:00.000Z') => ({
    id,
    name: id,
    repoRoot,
    tracker: { provider: 'linear', scope, project: null },
    createdAt,
  });
  const github = (id: string, repoRoot: string | null, scope: string, createdAt = '2026-10-10T00:00:00.000Z') => ({
    ...tracked(id, repoRoot, scope, createdAt),
    tracker: { provider: 'github', scope, project: null },
  });
  const plain = (id: string, repoRoot: string | null) => ({ id, name: id, repoRoot, tracker: null, createdAt: '2026-10-10T00:00:00.000Z' });
  const start = (over: Partial<Parameters<typeof issueZoneOf>[0]> = {}) => ({ issueId: 'ACME-12', zoneId: null, spawnerZoneId: null, repo: null, ...over });

  it("is its own zone, when that has a tracker and the issue's key names its team or repo, or none", () => {
    const zones = [tracked('jar', '/code/app', 'ACME'), tracked('ops', '/code/ops', 'OPS'), github('paper', '/code/paper', 'acme/paper')];
    expect(issueZoneOf(start({ issueId: 'OPS-3', zoneId: 'ops' }), zones)).toMatchObject({ id: 'ops' });
    expect(issueZoneOf(start({ issueId: 'acme/paper#4', zoneId: 'paper' }), zones)).toMatchObject({ id: 'paper' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'paper' }), zones)).toMatchObject({ id: 'paper' });
  });

  it("is never its own zone when the key names another team or repo, which it can't hold", () => {
    const zones = [tracked('jar', '/code/app', 'ACME'), tracked('ops', '/code/ops', 'OPS'), github('paper', '/code/paper', 'acme/paper')];
    expect(issueZoneOf(start({ issueId: 'WEB-9', zoneId: 'ops', spawnerZoneId: 'jar' }), zones)).toEqual({ provider: 'linear', scope: 'WEB' });
    expect(issueZoneOf(start({ issueId: 'acme/app#4', zoneId: 'paper' }), zones)).toBe(
      'no zone tracks acme/app, so acme/app#4 is not read: bind a zone to acme/app to start agents from its issues',
    );
  });

  it("is the tracker the issue's key names over its own zone's, when that has another team's", () => {
    const zones = [tracked('jar', '/code/app', 'ACME'), tracked('ops', '/code/ops', 'OPS')];
    expect(issueZoneOf(start({ issueId: 'ACME-12', zoneId: 'ops', spawnerZoneId: 'jar' }), zones)).toMatchObject({ id: 'jar' });
    expect(issueZoneOf(start({ issueId: 'acme-12', zoneId: 'ops' }), zones)).toMatchObject({ id: 'jar' });
  });

  it('is never a zone whose tracker could not hold an id of its shape, so a team key is read from its tracker', () => {
    // A Linear key is no GitHub issue, and `#4` no Linear one: a zone of the other kind is never tried.
    const zones = [github('paper', '/code/paper', 'acme/paper', '2026-10-01T00:00:00.000Z'), plain('board', '/code/board')];
    expect(issueZoneOf(start({ issueId: 'ACME-12', zoneId: 'board', repo: '/code/board' }), zones)).toEqual({ provider: 'linear', scope: 'ACME' });
    expect(issueZoneOf(start({ issueId: 'ACME-12', zoneId: 'paper' }), zones)).toEqual({ provider: 'linear', scope: 'ACME' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'jar' }), [tracked('jar', '/code/app', 'ACME')])).toBe(
      'no zone tracks a GitHub repo to read #4 from: bind a zone to its repo, or start the agent without an issue',
    );
  });

  it('is the zone on two trackers that holds the key, wherever the agent starts', () => {
    const zones = [github('paper', '/code/paper', 'acme/paper', '2026-10-01T00:00:00.000Z'), tracked('board', '/code/board', 'ACME')];
    expect(issueZoneOf(start({ issueId: 'ACME-12', zoneId: 'paper', spawnerZoneId: 'paper' }), zones)).toMatchObject({ id: 'board' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'board', spawnerZoneId: 'board' }), zones)).toMatchObject({ id: 'paper' });
  });

  it('refuses a GitHub repo no zone is bound to, which `gh` would read whoever owns it', () => {
    expect(issueZoneOf(start({ issueId: 'evil/repo#1' }), [plain('web', '/code/web')])).toBe(
      'no zone tracks evil/repo, so evil/repo#1 is not read: bind a zone to evil/repo to start agents from its issues',
    );
    expect(issueZoneOf(start({ issueId: 'evil/repo#1', zoneId: 'jar' }), [tracked('jar', '/code/app', 'ACME')])).toMatch(/^no zone tracks evil\/repo/);
  });

  it("is the Linear team its key names over the starter's zone and the board's, when no zone has that team", () => {
    const zones = [tracked('ops', '/code/ops', 'OPS'), github('paper', '/code/paper', 'acme/paper')];
    expect(issueZoneOf(start({ issueId: 'ACME-12', spawnerZoneId: 'ops', repo: '/code/ops' }), zones)).toEqual({ provider: 'linear', scope: 'ACME' });
    expect(issueZoneOf(start({ issueId: 'OPS-12' }), [plain('web', '/code/web')])).toEqual({ provider: 'linear', scope: 'OPS' });
  });

  it('is the one zone on the board with a tracker, from a zone or a repo with none', () => {
    const zones = [plain('scratch', null), plain('web', '/code/web'), tracked('planning', null, 'ACME')];
    expect(issueZoneOf(start({ zoneId: 'scratch' }), zones)).toMatchObject({ id: 'planning' });
    expect(issueZoneOf(start({ zoneId: 'web', repo: '/code/elsewhere' }), zones)).toMatchObject({ id: 'planning' });
    expect(issueZoneOf(start(), zones)).toMatchObject({ id: 'planning' });
  });

  it("is the tracker whose team the issue's key names, of several", () => {
    const zones = [tracked('ops', '/code/ops', 'OPS'), tracked('jar', '/code/app', 'ACME')];
    expect(issueZoneOf(start({ zoneId: null, issueId: 'acme-12' }), zones)).toMatchObject({ id: 'jar' });
    expect(issueZoneOf(start({ issueId: 'OPS-3' }), zones)).toMatchObject({ id: 'ops' });
  });

  it('is, of several that could have it, the zone of the agent that starts it, then a zone of its repo', () => {
    const zones = [github('one', '/code/one', 'acme/one'), github('two', '/code/two', 'acme/two'), plain('blank', null)];
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'blank', spawnerZoneId: 'two' }), zones)).toMatchObject({ id: 'two' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'blank', repo: '/code/one/packages/a' }), zones)).toMatchObject({ id: 'one' });
  });

  it('is the oldest of several zones sharing one tracker', () => {
    const zones = [github('late', '/code/b', 'acme/a', '2026-10-10T00:00:02.000Z'), github('early', '/code/a', 'acme/a', '2026-10-10T00:00:01.000Z')];
    expect(issueZoneOf(start({ issueId: '#4' }), zones)).toMatchObject({ id: 'early' });
  });

  it('says why, when no zone has a tracker or several trackers could have it', () => {
    expect(issueZoneOf(start({ issueId: '#12' }), [plain('web', '/code/web')])).toBe(
      'no zone on the board has a tracker to read #12 from: add one to a zone, or start the agent without an issue',
    );
    expect(issueZoneOf(start({ issueId: '#4' }), [github('one', '/code/one', 'acme/one'), github('two', '/code/two', 'acme/two')])).toBe(
      '#4 could be in the tracker of one or two: start the agent in the zone whose tracker has it',
    );
  });
});
