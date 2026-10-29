import { describe, expect, it } from 'vitest';
import type { Zone } from '@agent-board/daemon/protocol';
import { folderLabel } from './folders';
import { agentStartIn, dropPlace, issueScope, issueStartIn, trackerZoneFor } from './place-session';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';

const zone = { id: 'z', x: 1000, y: 1000, width: 800, height: 600 };

describe('dropPlace', () => {
  it('puts a tile dropped on bare board loose, centred on the pointer, its corner on the 20px grid', () => {
    expect(dropPlace({ x: 133, y: 77 }, [zone])).toEqual({
      zoneId: null,
      x: Math.round((133 - AGENT_TILE_SIZE.width / 2) / 20) * 20,
      y: Math.round((77 - AGENT_TILE_SIZE.height / 2) / 20) * 20,
    });
  });

  it('puts a tile dropped over a zone in it, at a place relative to it', () => {
    expect(dropPlace({ x: 1400, y: 1300 }, [zone])).toEqual({ zoneId: 'z', x: 280, y: 240 });
  });
});

describe('agentStartIn', () => {
  const unbound = { repoRoot: null, clone: null, defaultRepo: null, name: 'Ideas' };

  it('starts at once in a bound zone', () => {
    expect(agentStartIn({ ...unbound, repoRoot: '/code/app' })).toEqual({ kind: 'start' });
  });

  it('opens the New agent dialog in a group, with or without a default repo', () => {
    expect(agentStartIn(unbound)).toEqual({ kind: 'dialog' });
    expect(agentStartIn({ ...unbound, defaultRepo: '/code/app' })).toEqual({ kind: 'dialog' });
  });

  it('opens the dialog on bare board too, to ask for a repo', () => {
    expect(agentStartIn(undefined)).toEqual({ kind: 'dialog' });
  });

  it('refuses while the zone clones its repo', () => {
    const cloning = { ...unbound, clone: { repo: 'acme/app', path: '/r', phase: null, percent: null } };
    expect(agentStartIn(cloning)).toEqual({ kind: 'refuse', reason: 'Available after clone finishes' });
  });
});

const zoneOf = (id: string, fields: Partial<Zone> = {}): Zone => ({
  id,
  kind: 'unbound',
  repoRoot: null,
  folder: '',
  name: id,
  color: '#4c6ef5',
  fillOpacity: null,
  x: 0,
  y: 0,
  width: 720,
  height: 480,
  codexBypassHookTrust: true,
  trustsFolder: false,
  boardMcp: true,
  agentsOrchestrate: false,
  gateCommand: null,
  spacing: 'normal',
  priority: 'normal',
  usageHold: null,
  tracker: null,
  clone: null,
  managedClone: false,
  defaultRepo: null,
  groupFolder: null,
  userFolder: false,
  createdAt: '',
  ...fields,
});

describe('issues and the zones that track them', () => {
  const jar = { provider: 'linear' as const, id: 'ACME-12' };
  const gh = { provider: 'github' as const, id: 'acme/app#34' };
  const planning = zoneOf('planning', { tracker: { provider: 'linear', scope: 'ACME' } });
  const app = zoneOf('app', { kind: 'repo', repoRoot: '/code/app', tracker: { provider: 'github', scope: 'Acme/App' } });

  it('reads the scope from the issue ID', () => {
    expect(issueScope(jar)).toBe('ACME');
    expect(issueScope(gh)).toBe('acme/app');
  });

  it("finds the zone tracking it, the card's own first, ignoring the case of a GitHub repo", () => {
    const other = zoneOf('other', { tracker: { provider: 'linear', scope: 'ACME' } });
    expect(trackerZoneFor(jar, [planning, other])?.id).toBe('planning');
    expect(trackerZoneFor(jar, [planning, other], other)?.id).toBe('other');
    expect(trackerZoneFor(gh, [planning, app])?.id).toBe('app');
    expect(trackerZoneFor({ provider: 'linear', id: 'OPS-1' }, [planning, app])).toBeUndefined();
  });

  it('starts from the New agent dialog, the issue taken from the zone that tracks it, the card’s own first', () => {
    expect(issueStartIn(gh, app, [app])).toEqual({ kind: 'dialog', zone: app, issueZoneId: 'app' });
    const withDefault = zoneOf('d', { defaultRepo: '/code/app', tracker: planning.tracker });
    expect(issueStartIn(jar, withDefault, [withDefault])).toEqual({ kind: 'dialog', zone: withDefault, issueZoneId: 'd' });
    expect(issueStartIn(jar, planning, [planning])).toEqual({ kind: 'dialog', zone: planning, issueZoneId: 'planning' });
    // A group that neither tracks the issue nor has a repo asks all the same, for its repo.
    const elsewhere = zoneOf('e');
    expect(issueStartIn(jar, elsewhere, [elsewhere, planning])).toEqual({ kind: 'dialog', zone: elsewhere, issueZoneId: 'planning' });
    expect(issueStartIn(jar, undefined, [app, planning])).toEqual({ kind: 'dialog', zone: undefined, issueZoneId: 'planning' });
  });

  it('refuses when no zone tracks the issue, or while the zone clones', () => {
    expect(issueStartIn(jar, undefined, [app])).toEqual({ kind: 'refuse', reason: 'No zone on the board takes issues from ACME' });
    const cloning = zoneOf('c', { clone: { repo: 'acme/app', path: '/r', phase: null, percent: null } });
    expect(issueStartIn(jar, cloning, [cloning, planning]).kind).toBe('refuse');
  });
});

describe('folderLabel', () => {
  it('shows home as ~, and any other folder by its name', () => {
    expect(folderLabel('/Users/ada', '/Users/ada')).toBe('~');
    expect(folderLabel('/Users/ada/code/jarvis-api', '/Users/ada')).toBe('jarvis-api');
    expect(folderLabel('/', undefined)).toBe('/');
  });
});
