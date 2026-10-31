import { describe, expect, it } from 'vitest';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { fuzzyMatch, RECENT_LIMIT, SETTINGS_LIMIT, spotlightGroups, type SpotlightRow } from './spotlight-results';

const zone = (id: string, name: string): Zone => ({ id, name, color: '#3b5bdb' }) as Zone;

const agent = (name: string, more: Partial<Agent> = {}): Agent =>
  ({
    sessionId: `s-${name}`,
    name,
    zoneId: 'z1',
    branch: name.toLowerCase().replaceAll(' ', '-'),
    state: 'running',
    endedAt: null,
    exitCode: null,
    permissions: [],
    seen: false,
    flag: null,
    ask: null,
    plan: null,
    issue: null,
    lastMessage: null,
    compactingSince: null,
    finishedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...more,
  }) as Agent;

const shell = (name: string, more: Partial<Shell> = {}): Shell =>
  ({ id: `sh-${name}`, name, zoneId: 'z1', owner: null, cwd: '/code/web', createdAt: '2026-10-01T09:00:00.000Z', ...more }) as Shell;

const zones = [zone('z1', 'agent-board'), zone('z2', 'website')];
const names = (rows: readonly SpotlightRow[]) => rows.map((row) => row.name);

describe('spotlightGroups before anything is typed', () => {
  it('shows the agents that need you, then the others most recently active, then the zones', () => {
    const asking = agent('Review 202', { state: 'waiting', ask: { question: 'Approve the push?' } as Agent['ask'] });
    const older = agent('Theme packs', { createdAt: '2026-10-01T08:00:00.000Z' });
    const newer = agent('Master', { finishedAt: '2026-10-02T08:00:00.000Z' });
    const groups = spotlightGroups('', { agents: [older, asking, newer], shells: [], zones, shows: 'turns' });

    expect(groups.map((group) => group.label)).toEqual(['Needs you', 'Recent', 'Zones']);
    expect(names(groups[0]!.rows)).toEqual(['Review 202']);
    expect(groups[0]!.rows[0]!.sub).toBe('agent-board · asks: Approve the push?');
    expect(names(groups[1]!.rows)).toEqual(['Master', 'Theme packs']);
    expect(names(groups[2]!.rows)).toEqual(['agent-board', 'website']);
  });

  it('says what a waiting agent last asked in its terminal, on one line', () => {
    const asking = agent('Pick a database', { state: 'waiting', lastMessage: 'Which database should I use,\nPostgres or SQLite?' });
    const [needing] = spotlightGroups('', { agents: [asking], shells: [], zones, shows: 'turns' });
    expect(needing!.rows[0]!.sub).toBe('agent-board · Which database should I use, Postgres or SQLite?');
  });

  it('leaves out a seen ask, empty groups, and a shell that is another window’s tab', () => {
    const seen = agent('Seen ask', { state: 'waiting', seen: true });
    const tab = shell('Tab', { owner: { kind: 'agent', id: 's-x' } as Shell['owner'] });
    const groups = spotlightGroups('', { agents: [seen], shells: [tab, shell('Loose dev', { zoneId: null })], zones: [], shows: 'turns' });
    expect(groups.map((group) => group.label)).toEqual(['Recent']);
    expect(names(groups[0]!.rows)).toEqual(['Seen ask', 'Loose dev']);
    expect(groups[0]!.rows[1]!.sub).toBe('Loose · /code/web');
  });

  it(`keeps Recent to the ${RECENT_LIMIT} most recent`, () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, index) => agent(`Agent ${index}`, { createdAt: `2026-10-0${index + 1}T00:00:00.000Z` }));
    const [recent] = spotlightGroups('', { agents: many, shells: [], zones: [], shows: 'turns' });
    expect(recent!.rows).toHaveLength(RECENT_LIMIT);
    expect(recent!.rows[0]!.name).toBe(`Agent ${RECENT_LIMIT + 2}`);
  });
});

describe('spotlightGroups once something is typed', () => {
  it('flattens into one ranked list of sessions and zones, a match in the name first', () => {
    const byName = agent('Docs revisions', { zoneId: 'z2' });
    const byBranch = agent('Nightly', { branch: 'rev-cleanup' });
    const groups = spotlightGroups('rev', { agents: [byBranch, byName, agent('Other')], shells: [shell('review-tools')], zones, shows: 'turns' });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeUndefined();
    expect(names(groups[0]!.rows)).toEqual(['review-tools', 'Docs revisions', 'Nightly']);
  });

  it('marks where the name matched', () => {
    const [group] = spotlightGroups('rev', { agents: [agent('Docs revisions')], shells: [], zones, shows: 'turns' });
    expect(group!.rows[0]!.marks).toEqual([5, 6, 7]);
  });

  it('finds a session by its issue, branch, zone or what it asks', () => {
    const sources = {
      agents: [
        agent('One', { issue: { provider: 'linear', id: 'ABC-211', title: 'x', url: 'https://x' } }),
        agent('Two', { branch: 'feature/rename-things' }),
        agent('Three', { zoneId: 'z2' }),
        agent('Four', { state: 'waiting', ask: { question: 'Which database?' } as Agent['ask'] }),
      ],
      shells: [],
      zones,
      shows: 'turns' as const,
    };
    const found = (query: string) => names(spotlightGroups(query, sources)[0]?.rows ?? []);
    expect(found('abc-211')).toEqual(['One']);
    expect(found('rename-things')).toEqual(['Two']);
    expect(found('websi')).toEqual(['website', 'Three']);
    expect(found('database')).toEqual(['Four']);
  });

  it('finds what an agent says only by a whole run of letters, not scattered ones', () => {
    const chatty = agent('One', { lastMessage: 'Refactored the event loop, then verified it' });
    expect(spotlightGroups('rev', { agents: [chatty], shells: [], zones, shows: 'turns' })).toEqual([]);
    expect(names(spotlightGroups('event loop', { agents: [chatty], shells: [], zones, shows: 'turns' })[0]!.rows)).toEqual(['One']);
  });

  it('is empty when nothing matches', () => {
    expect(spotlightGroups('zzzz', { agents: [agent('One')], shells: [], zones, shows: 'turns' })).toEqual([]);
  });
});

describe('spotlightGroups and settings', () => {
  const settingRows = (query: string, simplified = false) =>
    spotlightGroups(query, { agents: [], shells: [], zones, shows: 'turns', simplified }).find((group) => group.label === 'Settings')?.rows ?? [];

  it('lists the settings that match after the sessions and zones, under Settings', () => {
    const groups = spotlightGroups('appear', { agents: [agent('Appearance pass')], shells: [], zones, shows: 'turns' });
    expect(groups.map((group) => group.label)).toEqual([undefined, 'Settings']);
    expect(names(groups[0]!.rows)).toEqual(['Appearance pass']);
    expect(groups[1]!.rows).toEqual([
      { key: 'setting:general.appearance', subject: { kind: 'setting', pane: 'general.appearance' }, name: 'Appearance', sub: 'Settings · General', marks: [0, 1, 2, 3, 4, 5] },
    ]);
  });

  it('finds a control by its label, opening its section, and by the other words it goes by, best first', () => {
    expect(settingRows('path').map((row) => [row.name, row.sub, row.subject])).toEqual([
      // The earlier match ranks first, as for a session.
      ['Codex path', 'Settings · Advanced › Programs', { kind: 'setting', pane: 'advanced.programs' }],
      ['Claude path', 'Settings · Advanced › Programs', { kind: 'setting', pane: 'advanced.programs' }],
    ]);
    // Only the label's letters are marked: a match in its other words marks none.
    expect(settingRows('dark').map((row) => [row.name, row.marks])).toEqual([['Mode', []]]);
  });

  it("finds a group's sections by the group's name, as the Settings window's search does", () => {
    expect(settingRows('advanced').map((row) => row.subject)).toEqual(
      // Equal matches, so by name: Background service, Command line, Held hand-offs, Programs, Web tabs.
      ['service', 'cli', 'handoffs', 'programs', 'webTabs'].map((section) => ({ kind: 'setting', pane: `advanced.${section}` })),
    );
    expect(names(settingRows('accounts'))).toEqual(['Other terminals']);
  });

  it('matches settings only by a whole run of letters, and lists at most a few', () => {
    expect(settingRows('apprnc')).toEqual([]);
    expect(settingRows('s').length).toBe(SETTINGS_LIMIT);
  });

  it('leaves out the settings only the Simplified design draws, under Classic', () => {
    expect(names(settingRows('technical'))).toEqual([]);
    expect(names(settingRows('technical', true))).toEqual(['Show technical details']);
  });

  it('lists no settings before anything is typed', () => {
    expect(spotlightGroups('', { agents: [], shells: [], zones: [], shows: 'turns' })).toEqual([]);
  });
});

describe('fuzzyMatch', () => {
  it('matches letters in order, ignoring case, and scores a whole run above scattered letters', () => {
    const run = fuzzyMatch('rev', 'Review 202');
    const scattered = fuzzyMatch('rev', 'Rename every');
    expect(run?.positions).toEqual([0, 1, 2]);
    expect(scattered?.positions).toEqual([0, 1, 8]);
    expect(run!.score).toBeGreaterThan(scattered!.score);
  });

  it('scores a match at a word’s start above one inside a word', () => {
    expect(fuzzyMatch('view', 'the view')!.score).toBeGreaterThan(fuzzyMatch('view', 'review')!.score);
  });

  it('misses letters out of order', () => {
    expect(fuzzyMatch('ver', 'Review')).toBeUndefined();
  });
});
