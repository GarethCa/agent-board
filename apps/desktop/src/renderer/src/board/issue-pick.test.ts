import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueFilters } from '@agent-board/daemon/protocol';
import { defaultPick, issuePickMenu, issuePickNote, menuOptions, pickValue, storedPick, storePick } from './issue-pick';

const TEAM = { provider: 'linear' as const, scope: 'ACME' };
const FILTERS: IssueFilters = {
  projects: [
    { id: 'p-board', name: 'Board polish', milestones: [{ id: 'm-beta', name: 'Beta' }] },
    { id: 'p-trackers', name: 'Trackers', milestones: [] },
  ],
  milestones: [],
};

describe("the issue picker's project select", () => {
  it('starts a team zone on its whole team, and a project zone on its own project', () => {
    expect(defaultPick(TEAM)).toEqual({ project: null });
    expect(defaultPick({ ...TEAM, project: 'p-trackers' })).toEqual({ project: 'p-trackers' });
  });

  it('lists the whole scope, then each project with its milestones under it', () => {
    const menu = issuePickMenu(TEAM, FILTERS);
    expect(menu.scope).toMatchObject({ label: 'All of ACME', kind: 'scope', pick: { project: null } });
    expect(menu.groups.map((group) => [group.label, group.options.map((option) => [option.label, option.pick])])).toEqual([
      [
        'Board polish',
        [
          ['All of Board polish', { project: 'p-board' }],
          ['Beta', { project: 'p-board', milestone: 'm-beta' }],
        ],
      ],
      ['Trackers', [['All of Trackers', { project: 'p-trackers' }]]],
    ]);
  });

  it("puts a project zone's own project on the menu when the tracker no longer lists it", () => {
    const menu = issuePickMenu({ ...TEAM, project: 'p-done' }, FILTERS);
    expect(menu.groups[0]).toEqual({
      label: "This zone's project",
      options: [expect.objectContaining({ pick: { project: 'p-done' } })],
    });
    expect(menuOptions(menu).map((option) => option.value)).toContain(pickValue(defaultPick({ ...TEAM, project: 'p-done' })));
  });

  it("lists a repo's milestones on their own when it is in no project, or projects can't be read", () => {
    const menu = issuePickMenu(
      { provider: 'github', scope: 'acme/app' },
      { projects: [], milestones: [{ id: '1', name: 'v1.0' }], missing: 'project-scope' },
    );
    expect(menu.scope.label).toBe('All of acme/app');
    expect(menu.groups).toEqual([
      { label: 'Milestones', options: [expect.objectContaining({ label: 'v1.0', kind: 'milestone', pick: { project: null, milestone: '1' } })] },
    ]);
  });

  it('gives the same value for the same pick, however it was written', () => {
    expect(pickValue({})).toBe(pickValue({ project: null }));
    expect(pickValue({ project: 'p', milestone: 'm' })).not.toBe(pickValue({ project: 'p' }));
  });
});

describe("the issue picker's note", () => {
  it("says why the select is missing when the filters can't be loaded", () => {
    expect(issuePickNote({ projects: [], milestones: [] }, 'query too complex')).toEqual({ kind: 'failed', message: 'query too complex' });
  });

  it("says when gh's login can't read GitHub Projects, and nothing otherwise", () => {
    expect(issuePickNote({ ...FILTERS, missing: 'project-scope' }, undefined)).toEqual({ kind: 'project-scope' });
    expect(issuePickNote(FILTERS, undefined)).toBeUndefined();
    expect(issuePickNote(undefined, undefined)).toBeUndefined();
  });
});

describe("a zone's remembered pick", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });

  it('is kept per zone', () => {
    expect(storedPick('zone-a')).toBeUndefined();
    storePick('zone-a', { project: 'p-board', milestone: 'm-beta' });
    storePick('zone-b', { project: null });
    expect(storedPick('zone-a')).toEqual({ project: 'p-board', milestone: 'm-beta' });
    expect(storedPick('zone-b')).toEqual({ project: null });
  });

  it('is forgotten when what was stored is not a pick', () => {
    localStorage.setItem('agent-board.issue-pick.zone-a', 'not json');
    expect(storedPick('zone-a')).toBeUndefined();
    localStorage.setItem('agent-board.issue-pick.zone-a', JSON.stringify({ project: 3 }));
    expect(storedPick('zone-a')).toBeUndefined();
  });
});
