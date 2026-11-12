import { describe, expect, it } from 'vitest';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { fuzzyMatch, RECENT_LIMIT, SETTINGS_LIMIT, CREWS_GROUP, FILTERS_GROUP, newAgentLeads, parseFilters, sideBySide, spotlightGroups, spotlightStep, type SpotlightRow } from './spotlight-results';

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
    ledBy: null,
    ask: null,
    plan: null,
    issue: null,
    lastMessage: null,
    compactingSince: null,
    finishedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    purpose: null,
    status: null,
    pullRequests: [],
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
    expect(groups[0]!.rows[0]!.sub).toBe('asks: Approve the push?');
    expect(names(groups[1]!.rows)).toEqual(['Master', 'Theme packs']);
    expect(names(groups[2]!.rows)).toEqual(['agent-board', 'website']);
  });

  it('says what a waiting agent last asked in its terminal, on one line, without its zone beside Recent', () => {
    const asking = agent('Pick a database', { state: 'waiting', lastMessage: 'Which database should I use,\nPostgres or SQLite?' });
    const [needing] = spotlightGroups('', { agents: [asking], shells: [], zones, shows: 'turns' });
    expect(needing!.rows[0]!.sub).toBe('Which database should I use, Postgres or SQLite?');
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

const pr = (number: number, title: string) => ({ number, title, state: 'OPEN', url: `https://example.com/pull/${number}` }) as unknown as NonNullable<Agent['pullRequests']>[number];
const issue = (id: string, title: string): Agent['issue'] => ({ provider: 'linear', id, title, url: 'https://x' });
const typed = (query: string, agents: Agent[], shells: Shell[] = []) => spotlightGroups(query, { agents, shells, zones, shows: 'turns' });
const only = (query: string, agents: Agent[], shells: Shell[] = []) => typed(query, agents, shells)[0]?.rows ?? [];

describe('what an agent says it is for', () => {
  it('is the sub line, in place of its zone and branch', () => {
    const [recent] = typed('', [agent('Quiet hours', { purpose: 'Hooks go quiet outside work hours' }), agent('Plain')]);
    expect(recent!.rows.map(({ sub, purpose }) => [sub, purpose])).toEqual([
      ['Hooks go quiet outside work hours', true],
      ['agent-board · plain', undefined],
    ]);
  });

  it('gives way to what an agent asks while it needs you', () => {
    const asking = agent('Asking', { state: 'waiting', purpose: 'Something', ask: { question: 'Push?' } as Agent['ask'] });
    expect(typed('', [asking])[0]!.rows[0]!.sub).toBe('asks: Push?');
    expect(typed('push', [asking])[0]!.rows[0]!.sub).toBe('agent-board · asks: Push?');
  });
});

describe('ranking a match by the field it is in', () => {
  // Each agent holds "overview" in one field only, at the start and not the whole field, so only the weights differ.
  const holding = {
    name: agent('Overview'),
    issue: agent('A', { issue: issue('OVERVIEW-1', 'x') }),
    desc: agent('B', { purpose: 'overview window' }),
    branch: agent('C', { branch: 'overview-x' }),
    prTitle: agent('D', { pullRequests: [pr(9, 'overview later')] }),
    status: agent('E', { status: { summary: 'overview next' } as Agent['status'] }),
    said: agent('F', { lastMessage: 'overview done' }),
  };

  it('ranks the name, then the issue, description, branch, PR title, status line and what it said', () => {
    const shuffled = [holding.said, holding.prTitle, holding.branch, holding.name, holding.status, holding.desc, holding.issue];
    expect(names(only('overview', shuffled))).toEqual(['Overview', 'A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('ranks a PR number with the issue, above the description', () => {
    const byNumber = agent('Numbered', { pullRequests: [pr(571, 'Hooks')] });
    const byDesc = agent('Described', { purpose: 'follow up #571' });
    expect(names(only('#571', [byDesc, byNumber]))).toEqual(['Numbered', 'Described']);
  });

  it('matches a PR number only as a whole run', () => {
    expect(only('51', [agent('Numbered', { pullRequests: [pr(571, 'Hooks')] })])).toEqual([]);
  });
});

describe('the labelled snippet of why a row matched', () => {
  it('names the field and marks the words, for a match outside the name', () => {
    const rows = only('overview', [
      agent('Numbered', { pullRequests: [pr(596, 'Overview window')] }),
      agent('Described', { purpose: 'Draws the overview' }),
      agent('Branched', { branch: 'fix-overview' }),
      agent('Talked', { lastMessage: 'the overview is done' }),
      agent('Busy', { status: { summary: 'on the overview' } as Agent['status'] }),
    ]);
    expect(Object.fromEntries(rows.map((row) => [row.name, row.snippet]))).toEqual({
      Described: { label: 'desc', text: 'Draws the overview', marks: [10, 11, 12, 13, 14, 15, 16, 17] },
      Branched: { label: 'branch', text: 'fix-overview', marks: [4, 5, 6, 7, 8, 9, 10, 11] },
      Numbered: { label: 'PR', text: '#596 Overview window', marks: [5, 6, 7, 8, 9, 10, 11, 12] },
      Busy: { label: 'status', text: 'on the overview', marks: [7, 8, 9, 10, 11, 12, 13, 14] },
      Talked: { label: 'said', text: 'the overview is done', marks: [4, 5, 6, 7, 8, 9, 10, 11] },
    });
  });

  it('marks a PR number in its snippet', () => {
    expect(only('#596', [agent('Numbered', { pullRequests: [pr(596, 'Overview window')] })])[0]!.snippet).toEqual({
      label: 'PR',
      text: '#596 Overview window',
      marks: [0, 1, 2, 3],
    });
  });

  it('is left out when the name matched best, which keeps its usual sub line', () => {
    const [row] = only('quiet', [agent('Quiet hours', { lastMessage: 'quiet now', purpose: 'Hooks go quiet' })]);
    expect(row!.snippet).toBeUndefined();
    expect(row!.sub).toBe('Hooks go quiet');
  });

  it('starts at a word near the match in a long field, after an ellipsis', () => {
    const said = 'I have finished the first pass over the code and rebased on the hooks branch';
    const [row] = only('rebased', [agent('Long', { lastMessage: said })]);
    expect(row!.snippet!.text.startsWith('…')).toBe(true);
    expect(row!.snippet!.text.endsWith('rebased on the hooks branch')).toBe(true);
    const marked = row!.snippet!.marks.map((at) => row!.snippet!.text[at]).join('');
    expect(marked).toBe('rebased');
  });
});

describe('colon prefixes', () => {
  it('reads each prefix, its value to the next space, and the words left', () => {
    expect(parseFilters('zone:hiit review')).toEqual({ filters: [{ prefix: 'zone:', value: 'hiit' }], rest: 'review' });
    expect(parseFilters('pr: Issue:ABC-1 docs')).toEqual({
      filters: [
        { prefix: 'pr:', value: '' },
        { prefix: 'issue:', value: 'ABC-1' },
      ],
      rest: 'docs',
    });
    expect(parseFilters('plain words')).toEqual({ filters: [], rest: 'plain words' });
  });

  it('lists the filters for a lone colon, and those a started name fits', () => {
    const [group] = typed(':', [agent('One')]);
    expect(group!.label).toBe(FILTERS_GROUP);
    expect(names(group!.rows)).toEqual(['zone:', 'pr:', 'issue:']);
    expect(names(typed(':zo', [agent('One')])[0]!.rows)).toEqual(['zone:']);
  });

  it('keeps the sessions in a zone, ranked by the words left', () => {
    const inSite = [agent('Site review', { zoneId: 'z2' }), agent('Site deploy', { zoneId: 'z2' })];
    const sources = [...inSite, agent('Board review')];
    expect(names(only('zone:webs review', sources, [shell('web shell', { zoneId: 'z2' })]))).toEqual(['Site review']);
    expect(names(only('zone:website', sources, [shell('web shell', { zoneId: 'z2' })])).sort()).toEqual(['Site deploy', 'Site review', 'web shell']);
  });

  it('keeps agents with a pull request, by its number or title, with the PR as the snippet', () => {
    const agents = [agent('Hooks', { pullRequests: [pr(571, 'Hooks go quiet')] }), agent('Overview', { pullRequests: [pr(596, 'Overview window')] }), agent('None')];
    expect(names(only('pr:', agents)).sort()).toEqual(['Hooks', 'Overview']);
    expect(names(only('pr:#571', agents))).toEqual(['Hooks']);
    expect(names(only('pr:overview', agents))).toEqual(['Overview']);
    expect(only('pr:571', agents)[0]!.snippet).toEqual({ label: 'PR', text: '#571 Hooks go quiet', marks: [] });
  });

  it('keeps agents on an issue, by its id or title, and no shells', () => {
    const agents = [agent('One', { issue: issue('ABC-12', 'Login page') }), agent('Two', { issue: issue('ABC-99', 'Billing') }), agent('Three')];
    expect(names(only('issue:abc-12', agents, [shell('abc-12 shell')]))).toEqual(['One']);
    expect(names(only('issue:billing', agents))).toEqual(['Two']);
    expect(only('issue:zzz', agents)).toEqual([]);
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
      // Equal matches, so by name: Background service, Command line, Held hand-offs, Programs, Terminals, the first five.
      ['service', 'cli', 'handoffs', 'programs', 'terminals'].map((section) => ({ kind: 'setting', pane: `advanced.${section}` })),
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

  it("leaves out Classic's Agent notes section under the Simplified design, and lists it under Classic", () => {
    expect(names(settingRows('agent notes'))).toContain('Agent notes');
    expect(names(settingRows('agent notes', true))).not.toContain('Agent notes');
    expect(names(settingRows('terminal card', true))).toEqual([]);
  });

  it("lists the agent sidebar's choice under Classic, and not under the Simplified design", () => {
    expect(names(settingRows('agent sidebar'))).toContain('Agent sidebar');
    expect(names(settingRows('agent sidebar', true))).not.toContain('Agent sidebar');
  });

  it('lists no settings before anything is typed', () => {
    expect(spotlightGroups('', { agents: [], shells: [], zones: [], shows: 'turns' })).toEqual([]);
  });
});

describe('spotlightGroups and windows', () => {
  const docs = agent('Docs', { sessionId: 's-docs', branch: 'margins-docs' });
  const api = agent('API', { sessionId: 's-api' });
  const other = agent('Other', { sessionId: 's-other' });
  const windows = [
    { kind: 'session' as const, id: 's-api', title: 'API', placement: 'docked' as const },
    { kind: 'session' as const, id: 's-docs', title: 'Docs', placement: 'shown' as const },
  ];
  const sources = { agents: [docs, api, other], shells: [], zones, shows: 'turns' as const, windows, simplified: true };

  it('lists open windows before minimised ones, first, and not again below', () => {
    const groups = spotlightGroups('', sources);
    expect(groups.map((group) => group.label)).toEqual(['Windows', 'Recent', 'Zones']);
    expect(names(groups[0]!.rows)).toEqual(['Docs', 'API']);
    expect(groups[0]!.rows.map((row) => row.window)).toEqual(['shown', 'docked']);
    expect(groups[0]!.rows.map((row) => row.sub.split(' · ')[0])).toEqual(['Open', 'Minimised']);
    expect(names(groups[1]!.rows)).toEqual(['Other']);
  });

  it('puts a matching window above the other matches, and keeps one that matched only by its branch below', () => {
    const [windowsGroup, ...rest] = spotlightGroups('doc', sources);
    expect(windowsGroup!.label).toBe('Windows');
    expect(names(windowsGroup!.rows)).toEqual(['Docs']);
    expect(rest.flatMap((group) => group.rows).some((row) => row.key === 'agent:s-docs')).toBe(false);
    const byBranch = spotlightGroups('margins', sources);
    expect(byBranch.some((group) => group.label === 'Windows')).toBe(false);
    expect(names(byBranch[0]!.rows)).toEqual(['Docs']);
  });

  it('lists the window of the session the view shows last, so ↵ lands on another', () => {
    const [group] = spotlightGroups('', { ...sources, current: 's-docs' });
    expect(names(group!.rows)).toEqual(['API', 'Docs']);
  });

  it('lists no windows under Classic, whose dock holds them', () => {
    const groups = spotlightGroups('', { ...sources, simplified: false });
    expect(groups.some((group) => group.label === 'Windows')).toBe(false);
    expect(names(groups.flatMap((group) => group.rows))).toEqual(expect.arrayContaining(['Docs', 'API']));
  });
});

describe('the Crews group', () => {
  const sources = { agents: [], shells: [], zones: [], shows: 'turns' as const, canStartAgent: true, prefabs: [{ name: 'Implementer + reviewer', purpose: 'Build and review' }, { name: 'Spike + reviewer', purpose: 'Try an idea' }] };
  const crews = (query: string, more: object = {}) => spotlightGroups(query, { ...sources, ...more }).find((group) => group.label === CREWS_GROUP)?.rows.map((row) => row.subject);

  it('finds prefabs by name and what they are for, and the library, in either design, only once something is typed', () => {
    expect(crews('')).toBeUndefined();
    expect(crews('spike')).toEqual([{ kind: 'crew', prefab: 'Spike + reviewer' }]);
    expect(crews('try an')).toEqual([{ kind: 'crew', prefab: 'Spike + reviewer' }]);
    expect(crews('library')).toEqual([{ kind: 'crew', prefab: null }]);
    expect(crews('crew', { simplified: true })).toEqual(expect.arrayContaining([{ kind: 'crew', prefab: 'Implementer + reviewer' }, { kind: 'crew', prefab: null }]));
  });

  it('leads with a crew that matches, so ↵ opens it, and New agent named … with no crew to find', () => {
    expect(newAgentLeads(spotlightGroups('spike', sources))).toBe(false);
    expect(spotlightGroups('spike', sources)[0]!.rows[0]!.subject).toEqual({ kind: 'crew', prefab: 'Spike + reviewer' });
    expect(newAgentLeads(spotlightGroups('zzz', sources))).toBe(true);
    // In what a crew is for, but not its name: it is listed, and an agent can still be named that.
    expect(crews('try an')).toEqual([{ kind: 'crew', prefab: 'Spike + reviewer' }]);
    expect(newAgentLeads(spotlightGroups('try an', sources))).toBe(true);
  });

  it('lists none where no crew could start', () => {
    expect(crews('spike', { canStartAgent: false })).toBeUndefined();
  });
});

describe('spotlightGroups and actions', () => {
  const sources = { agents: [], shells: [], zones, shows: 'turns' as const, canStartAgent: true, simplified: true };
  const actionNames = (query: string, more = {}) => names(spotlightGroups(query, { ...sources, ...more }).find((group) => group.label === 'Actions')?.rows ?? []);

  it('finds New agent and Open Settings by their name or other words', () => {
    expect(actionNames('new ag')).toEqual(['New agent']);
    expect(actionNames('preferences')).toEqual(['Open Settings']);
    // A whole run of letters, as settings need: scattered ones in "New agent" or "Open Settings" don't.
    expect(actionNames('ops')).toEqual([]);
    expect(actionNames('nw')).toEqual([]);
  });

  it('offers New agent only where one can start, lists no actions before typing, and under Classic only Park a thought', () => {
    expect(actionNames('new ag', { canStartAgent: false })).toEqual([]);
    expect(spotlightGroups('', sources).some((group) => group.label === 'Actions')).toBe(false);
    expect(actionNames('new ag', { simplified: false })).toEqual([]);
    expect(actionNames('preferences', { simplified: false })).toEqual([]);
  });

  it('finds Park a thought, under either design, by its name or other words, its key in its sub line', () => {
    for (const simplified of [true, false]) {
      expect(actionNames('park', { simplified })).toEqual(['Park a thought']);
      expect(actionNames('idea', { simplified })).toEqual(['Park a thought']);
    }
    const row = spotlightGroups('park', sources).find((group) => group.label === 'Actions')?.rows[0];
    expect(row?.sub).toMatch(/your queue · (⌘⇧P|Ctrl\+Shift\+P)$/);
  });

  it('leaves Park a thought’s key out of its sub line while the extended keys are off, as the key does nothing then', () => {
    const row = spotlightGroups('park', { ...sources, extended: false }).find((group) => group.label === 'Actions')?.rows[0];
    expect(row?.sub).toBe('A line at the back of your queue');
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

describe('spotlightGroups and the Dock setting under Classic', () => {
  const docs = agent('Docs', { sessionId: 's-docs' });
  const api = agent('API', { sessionId: 's-api' });
  const windows = [
    { kind: 'session' as const, id: 's-api', title: 'API', placement: 'docked' as const },
    { kind: 'session' as const, id: 's-docs', title: 'Docs', placement: 'docked' as const, pinned: true },
  ];
  const sources = { agents: [docs, api], shells: [], zones, shows: 'turns' as const };

  it('lists the windows given in a Windows group once the dock leaves them out, minimised first in its sub line', () => {
    const groups = spotlightGroups('', { ...sources, windows: [windows[0]!], windowsListed: true });
    expect(groups.map((group) => group.label)).toEqual(['Windows', 'Recent', 'Zones']);
    expect(names(groups[0]!.rows)).toEqual(['API']);
    expect(groups[0]!.rows[0]!.sub.split(' · ')[0]).toBe('Minimised');
    expect(names(groups[1]!.rows)).toEqual(['Docs']);
  });

  it('finds a window the dock leaves out by typing its name', () => {
    const [group] = spotlightGroups('api', { ...sources, windows, windowsListed: true });
    expect(group!.label).toBe('Windows');
    expect(group!.rows[0]!.window).toBe('docked');
  });

  it('adds no Windows group while the dock shows everything', () => {
    expect(spotlightGroups('', { ...sources, windows }).some((group) => group.label === 'Windows')).toBe(false);
  });
});

describe('spotlightStep, the arrow keys over Needs you beside Recent', () => {
  const asking = (name: string) => agent(name, { state: 'waiting', ask: { question: 'Go?' } as Agent['ask'] });
  const groups = spotlightGroups('', {
    agents: [asking('N1'), asking('N2'), agent('R1', { createdAt: '2026-10-03T00:00:00.000Z' }), agent('R2', { createdAt: '2026-10-02T00:00:00.000Z' }), agent('R3')],
    shells: [],
    zones,
    shows: 'turns',
  });
  const key = (name: string) => `agent:s-${name}`;

  it('lays them side by side only while both are listed', () => {
    expect(sideBySide(groups)).toBe(true);
    expect(sideBySide(typed('', [agent('R1')]))).toBe(false);
    expect(sideBySide(typed('r', [asking('N1'), agent('R1')]))).toBe(false);
  });

  it('crosses to the same place in the other column with ← →, the last row of a shorter one', () => {
    expect(spotlightStep(groups, key('N2'), 'right')).toBe(key('R2'));
    expect(spotlightStep(groups, key('R3'), 'left')).toBe(key('N2'));
    expect(spotlightStep(groups, key('R1'), 'right')).toBe(key('R1'));
    expect(spotlightStep(groups, 'zone:z1', 'left')).toBe('zone:z1');
  });

  it('moves within a column with ↑ ↓, then on to the band below and round to the first row', () => {
    expect(spotlightStep(groups, key('N1'), 'down')).toBe(key('N2'));
    expect(spotlightStep(groups, key('N2'), 'down')).toBe('zone:z1');
    expect(spotlightStep(groups, key('R3'), 'down')).toBe('zone:z1');
    expect(spotlightStep(groups, 'zone:z1', 'up')).toBe(key('N2'));
    expect(spotlightStep(groups, 'zone:z2', 'down')).toBe(key('N1'));
    expect(spotlightStep(groups, key('R1'), 'up')).toBe('zone:z2');
  });

  it('walks Recent under Needs you once a narrow window stacks them, and ← → stay put', () => {
    expect(spotlightStep(groups, key('N2'), 'down', true)).toBe(key('R1'));
    expect(spotlightStep(groups, key('R1'), 'up', true)).toBe(key('N2'));
    expect(spotlightStep(groups, key('R3'), 'down', true)).toBe('zone:z1');
    expect(spotlightStep(groups, 'zone:z1', 'up', true)).toBe(key('R3'));
    expect(spotlightStep(groups, key('N2'), 'right', true)).toBe(key('N2'));
    expect(spotlightStep(groups, key('R2'), 'left', true)).toBe(key('R2'));
  });

  it('starts at the first row when none is active, and walks a single list as before', () => {
    expect(spotlightStep(groups, undefined, 'down')).toBe(key('N1'));
    const flat = typed('qx', [agent('Qx1'), agent('Qx2')]);
    expect(spotlightStep(flat, key('Qx1'), 'down')).toBe(key('Qx2'));
    expect(spotlightStep(flat, key('Qx2'), 'down')).toBe(key('Qx1'));
    expect(spotlightStep(flat, key('Qx1'), 'up')).toBe(key('Qx2'));
  });
});
