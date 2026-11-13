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
  const plain = (id: string, repoRoot: string | null) => ({ id, name: id, repoRoot, tracker: null, createdAt: '2026-10-10T00:00:00.000Z' });
  const start = (over: Partial<Parameters<typeof issueZoneOf>[0]> = {}) => ({ issueId: 'ACME-12', zoneId: null, spawnerZoneId: null, repo: null, ...over });

  it("is its own zone, when that has a tracker and the issue's key names its team, no team, or a team no zone has", () => {
    const zones = [tracked('jar', '/code/app', 'ACME'), tracked('ops', '/code/ops', 'OPS')];
    expect(issueZoneOf(start({ issueId: 'OPS-3', zoneId: 'ops' }), zones)).toMatchObject({ id: 'ops' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'ops', spawnerZoneId: 'jar' }), zones)).toMatchObject({ id: 'ops' });
    expect(issueZoneOf(start({ issueId: 'WEB-9', zoneId: 'ops', spawnerZoneId: 'jar' }), zones)).toMatchObject({ id: 'ops' });
  });

  it("is the tracker the issue's key names over its own zone's, when that has another team's", () => {
    const zones = [tracked('jar', '/code/app', 'ACME'), tracked('ops', '/code/ops', 'OPS')];
    expect(issueZoneOf(start({ issueId: 'ACME-12', zoneId: 'ops', spawnerZoneId: 'jar' }), zones)).toMatchObject({ id: 'jar' });
    expect(issueZoneOf(start({ issueId: 'acme-12', zoneId: 'ops' }), zones)).toMatchObject({ id: 'jar' });
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
    const zones = [tracked('one', '/code/one', 'ACME'), tracked('two', '/code/two', 'OPS'), plain('blank', null)];
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'blank', spawnerZoneId: 'two' }), zones)).toMatchObject({ id: 'two' });
    expect(issueZoneOf(start({ issueId: '#4', zoneId: 'blank', repo: '/code/one/packages/a' }), zones)).toMatchObject({ id: 'one' });
  });

  it('is the oldest of several zones sharing one tracker', () => {
    const zones = [tracked('late', '/code/b', 'ACME', '2026-10-10T00:00:02.000Z'), tracked('early', '/code/a', 'ACME', '2026-10-10T00:00:01.000Z')];
    expect(issueZoneOf(start({ issueId: '#4' }), zones)).toMatchObject({ id: 'early' });
  });

  it('says why, when no zone has a tracker or several trackers could have it', () => {
    expect(issueZoneOf(start({ issueId: 'OPS-12' }), [plain('web', '/code/web')])).toBe(
      'no zone on the board has a tracker to read OPS-12 from: add one to a zone, or start the agent without an issue',
    );
    expect(issueZoneOf(start({ issueId: '#4' }), [tracked('one', '/code/one', 'ACME'), tracked('two', '/code/two', 'OPS')])).toBe(
      '#4 could be in the tracker of one or two: start the agent in the zone whose tracker has it',
    );
  });
});
