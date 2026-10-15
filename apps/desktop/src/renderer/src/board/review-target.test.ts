import { describe, expect, it } from 'vitest';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { reviewable, reviewSpawn } from './review-target';

const zone = (fields: Partial<Zone>) => ({ id: 'z', repoRoot: '/r/storefront', defaultRepo: null, ...fields }) as Zone;
const agent = (sessionId: string, fields: Partial<Agent>) =>
  ({ sessionId, name: sessionId, zoneId: 'z', repoRoot: '/r/storefront', branch: `${sessionId}-branch`, ...fields }) as Agent;

describe('what a reviewer started in a zone can review', () => {
  it('is the branch of each agent in the zone or of its repo, newest first, never a branchless one', () => {
    const agents = [agent('a', {}), agent('b', { zoneId: 'other' }), agent('c', { branch: '' }), agent('d', { zoneId: 'other', repoRoot: '/r/api' })];

    expect(reviewable(zone({}), agents).map((each) => each.sessionId)).toEqual(['b', 'a']);
  });

  it('includes an agent of another repo in the zone, and starts the reviewer in that agent’s repo', () => {
    const api = agent('api', { repoRoot: '/r/api', branch: 'fix-login-flake' });

    expect(reviewable(zone({}), [api])).toEqual([api]);
    expect(reviewSpawn(zone({}), api)).toEqual({ baseBranch: 'fix-login-flake', repo: { path: '/r/api' } });
  });

  it('starts it in the zone’s own repo for one of its agents, so nothing is added to the recent repos', () => {
    expect(reviewSpawn(zone({}), agent('a', {}))).toEqual({ baseBranch: 'a-branch' });
  });

  it('always names the repo in a group, whose repo is its default repo or none', () => {
    const group = zone({ repoRoot: null, defaultRepo: '/r/storefront' });

    expect(reviewSpawn(group, agent('a', {}))).toEqual({ baseBranch: 'a-branch', repo: { path: '/r/storefront' } });
  });

  it('reviews the checked-out branch of the zone’s repo when no agent is picked', () => {
    expect(reviewSpawn(zone({}), undefined)).toEqual({});
  });
});
