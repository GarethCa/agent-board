import { describe, expect, it } from 'vitest';
import type { LibraryPrefab, Zone, ZoneTracker } from '@agent-board/daemon/protocol';
import { crewStartBlock, takesTicket, ticketLookupHint, ticketStartBlock } from './start-checks';

const zone = (fields: Partial<Zone> = {}): Zone => ({ id: 'z1', name: 'web', repoRoot: '/code/web', defaultRepo: null, tracker: null, ...fields }) as Zone;
const group = zone({ id: 'g1', name: 'Local Banking', repoRoot: null });
const linear = { provider: 'linear', scope: 'team-1', project: null } as unknown as ZoneTracker;

describe('the crew prompt’s Start', () => {
  it('starts once every box it shows is filled in', () => {
    expect(crewStartBlock({ zones: [zone()], zone: zone(), repo: undefined, prompt: 'Add a footer', ticket: undefined })).toBeUndefined();
    expect(crewStartBlock({ zones: [group], zone: group, repo: '/code/bank', prompt: 'Add a footer', ticket: undefined })).toBeUndefined();
  });

  it('says to choose a repo, next to the Repo box, in a group with none', () => {
    expect(crewStartBlock({ zones: [group], zone: group, repo: undefined, prompt: 'Add a footer', ticket: undefined })).toEqual({
      box: 'repo',
      reason: 'Local Banking has no repo: choose the one it works in.',
    });
  });

  it('asks for the prompt when it shows no ticket box', () => {
    expect(crewStartBlock({ zones: [zone()], zone: zone(), repo: undefined, prompt: '  ', ticket: undefined })).toEqual({ box: 'work', reason: 'Say what it should do.' });
  });

  it('starts a prefab that takes a ticket on its ticket alone, with no tracker linked', () => {
    expect(crewStartBlock({ zones: [zone()], zone: zone(), repo: undefined, prompt: '', ticket: 'ABC-12' })).toBeUndefined();
    expect(crewStartBlock({ zones: [zone()], zone: zone(), repo: undefined, prompt: '', ticket: '' })).toEqual({
      box: 'work',
      reason: 'Give it its ticket, or say what it should do.',
    });
  });

  it('asks for a zone when the board has none', () => {
    expect(crewStartBlock({ zones: [], zone: undefined, repo: undefined, prompt: 'Add a footer', ticket: undefined })?.box).toBe('zone');
  });
});

describe('the New ticket sheet’s Start ticket', () => {
  const filled = { zones: [group], zone: group, repo: '/code/bank', prompt: '', ticket: 'ABC-12', preset: true };

  it('starts in a group with no repo once its repo is chosen', () => {
    expect(ticketStartBlock(filled)).toBeUndefined();
    expect(ticketStartBlock({ ...filled, repo: undefined })?.box).toBe('repo');
  });

  it('says to pick its helpers when no preset is picked', () => {
    expect(ticketStartBlock({ ...filled, preset: false })).toEqual({ box: 'helpers', reason: 'Pick its helpers.' });
  });

  it('wants its ticket or its prompt', () => {
    expect(ticketStartBlock({ ...filled, ticket: ' ' })?.box).toBe('work');
    expect(ticketStartBlock({ ...filled, ticket: '', prompt: 'Add a footer' })).toBeUndefined();
  });
});

describe('a prefab that takes a ticket', () => {
  const prefab = (fields: Partial<LibraryPrefab>) => ({ onBoard: 'card', ...fields }) as LibraryPrefab;

  it('is one drafted with a ticket input', () => {
    expect(takesTicket(prefab({ inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'ticket', kind: 'ticket' }] }))).toBe(true);
    expect(takesTicket(prefab({ inputs: [{ id: 'prompt', kind: 'prompt' }] }))).toBe(false);
    expect(takesTicket(prefab({}))).toBe(false);
  });
});

describe('the look-it-up hint', () => {
  it('says the agent looks a typed ticket up itself when no zone reads issues', () => {
    expect(ticketLookupHint([zone(), group], 'ABC-12')).toMatch(/looks it up itself/);
  });

  it('says nothing with no ticket typed, or with a tracker linked', () => {
    expect(ticketLookupHint([zone()], '')).toBeUndefined();
    expect(ticketLookupHint([zone({ tracker: linear }), group], 'ABC-12')).toBeUndefined();
  });
});
