import { describe, expect, it } from 'vitest';
import { repoZoneOf } from '../src/repo-zone.ts';

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
