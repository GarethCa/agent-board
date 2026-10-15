import { describe, expect, it } from 'vitest';
import { zoneDeleteText, type ZoneToDelete } from './delete-zones';

const zone = (name: string, fields: Partial<ZoneToDelete['zone']> = {}, tiles = 0, connectors = 0): ZoneToDelete => ({
  zone: { name, repoRoot: null, managedClone: false, ...fields },
  tiles,
  connectors,
});

describe('zoneDeleteText', () => {
  it('names one zone in the title and the line, and says its tiles stay where they are and nothing of a session goes', () => {
    const { title, lines, cloneLabel } = zoneDeleteText([zone('App', { repoRoot: '/work/app' }, 2)]);
    expect(title).toBe('Delete zone App?');
    expect(lines[0]).toBe('App comes off the board. Its 2 tiles stay on the board where they are.');
    expect(lines.join(' ')).toContain('Its 2 tiles stay on the board where they are');
    expect(lines.join(' ')).toContain("No session, worktree or branch is deleted, and the repo's folder isn't touched");
    expect(lines.join(' ')).toContain('⌘Z brings it back');
    expect(cloneLabel).toBeUndefined();
  });

  it('names several zones once, with the tiles of all of them', () => {
    const { title, lines } = zoneDeleteText([zone('A', {}, 1), zone('B', {}, 0), zone('C', {}, 2)]);
    expect(title).toBe('Delete 3 zones?');
    expect(lines[0]).toBe('A, B and C come off the board. Their 3 tiles stay where they are.');
    expect(lines.join(' ')).toContain('⌘Z brings them back');
  });

  it('says only what matters for an empty group, and mentions the connectors that go with a zone', () => {
    expect(zoneDeleteText([zone('G')]).lines).toEqual(['G comes off the board. ⌘Z brings it back.']);
    expect(zoneDeleteText([zone('G', {}, 0, 2)]).lines.join(' ')).toContain('The connectors on it go with it');
  });

  it('says one tile stays where it is, for one zone and for several', () => {
    expect(zoneDeleteText([zone('A', {}, 1)]).lines[0]).toBe('A comes off the board. Its tile stays on the board where it is.');
    expect(zoneDeleteText([zone('A', {}, 1), zone('B')]).lines[0]).toBe('A and B come off the board. Their tile stays where it is.');
  });

  it("offers to delete a managed clone, naming it and saying undo can't bring it back, with ~ for the home folder", () => {
    const { cloneLabel } = zoneDeleteText([zone('App', { repoRoot: '/Users/me/.agent-board/repos/acme/app', managedClone: true })], '/Users/me');
    expect(cloneLabel).toBe("Also delete the clone in ~/.agent-board/repos/acme/app (⌘Z can't bring it back)");
  });

  it('names each clone with its zone when there are several, and by full path outside the home folder', () => {
    const clone = (name: string, repoRoot: string) => zone(name, { repoRoot, managedClone: true });
    expect(zoneDeleteText([clone('A', '/h/repos/a/a'), clone('B', '/elsewhere/b/b'), zone('C')], '/h').cloneLabel).toBe(
      "Also delete the clones in A: ~/repos/a/a, B: /elsewhere/b/b (⌘Z can't bring it back)",
    );
  });
});
