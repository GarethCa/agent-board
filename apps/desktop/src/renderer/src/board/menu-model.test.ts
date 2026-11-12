import { describe, expect, it, vi } from 'vitest';
import { ZONE_COLORS, type Agent, type ExternalSession, type GateRun, type LibraryPrefab, type ReviewRound, type Shell, type Zone } from '@agent-board/daemon/protocol';
import { keyText } from '../keys/registry';
import { runGateShortcut } from '../session/window-keys';
import { agentMenu, agentTileMenu, bindEntries, chipMenu, externalMenu, menuIds, projectContextMenu, projectMenu, shellMenu, tidyMenu, zoneMenu, zoneTabEntries, type AgentMenuInput, type AgentTileMenuInput, type ModelEntry, type ProjectContextMenuInput, type ZoneMenuInput, type ShellMenuInput, type TileBoardActions } from './menu-model';
import { galleryAgent } from './TileGallery';

const AT = '2026-10-22T12:00:00.000Z';

/** Handlers that remember what was called, with what. */
const library = vi.hoisted(() => ({ current: [] as readonly unknown[] }));
vi.mock('../crews/prefab-store', async (original) => ({
  ...(await original<object>()),
  crewGroups: () => {
    const prefabs = library.current as LibraryPrefab[];
    return [prefabs.filter((prefab) => !prefab.builtIn), prefabs.filter((prefab) => prefab.builtIn)].filter((group) => group.length > 0);
  },
}));

function spies<T>(): T & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  return new Proxy({ calls } as T & { calls: [string, unknown[]][] }, {
    get: (target, name) => (name === 'calls' ? calls : (...args: unknown[]) => void calls.push([String(name), args])),
  });
}

function agentInput(agent: Agent, more: Partial<AgentMenuInput> = {}): AgentMenuInput {
  return { nodeId: 'n1', agent, clickOpens: 'window', gate: undefined, rounds: [], rename: () => {}, actions: spies(), ...more };
}

const round = (status: ReviewRound['status'], number = 1): ReviewRound => ({
  id: `r${number}`,
  implementer: 'gallery-running',
  round: number,
  reviewer: null,
  head: null,
  status,
  doc: null,
  failedBecause: null,
  createdAt: AT,
  finishedAt: null,
  sentAt: null,
  dismissedAt: null,
});

/** The row with this id, wherever it is in the menu. */
function row(entries: readonly ModelEntry[], id: string): ModelEntry & { label: string } {
  for (const entry of entries) {
    if (entry === 'separator' || 'heading' in entry) continue;
    if (entry.id === id) return entry;
  }
  throw new Error(`no row ${id}`);
}

const running = galleryAgent('running');
const ended: Agent = { ...galleryAgent('done'), endedAt: AT };

describe("an agent's menu", () => {
  it("lists a running agent's rows, in order", () => {
    expect(menuIds(agentMenu(agentInput(running)))).toEqual([
      'expand', 'pop-out', 'pause', 'rename', 'schedule', 'link-issue', 'mute',
      'reasoning', 'reasoning/default', 'reasoning/low', 'reasoning/medium', 'reasoning/high', 'reasoning/xhigh', 'reasoning/max',
      'start-review', 'run-gate', 'delete',
    ]);
  });

  it("offers the reasoning levels its harness takes, its own ticked, and says when it takes a new one", () => {
    const claude = row(agentMenu(agentInput({ ...running, harness: 'claude', effort: 'high' })), 'reasoning') as Extract<ModelEntry, { entries: unknown }>;
    expect(claude).toMatchObject({ label: 'Reasoning', detail: 'High' });
    expect(claude.entries[0]).toEqual({ heading: 'Typed at its prompt between turns' });
    // No harness can be told its own default live: it waits for a restart, and says so.
    expect(claude.entries[1]).toMatchObject({ label: 'Default', hint: 'Applies when the agent restarts' });
    expect(claude.entries.at(-1)).toMatchObject({ label: 'Max', hint: 'Slowest, most usage' });
    const codex = row(agentMenu(agentInput({ ...running, harness: 'codex' })), 'reasoning') as Extract<ModelEntry, { entries: unknown }>;
    expect(codex).toMatchObject({ detail: 'Default', entries: [{ heading: 'Applies when the agent restarts' }, ...['Default', 'Low', 'Medium', 'High', 'Extra high'].map((label) => ({ label }))] });
    expect(menuIds(agentMenu(agentInput(ended)))).toContain('reasoning');
    const actions = spies<AgentMenuInput['actions']>();
    ((row(agentMenu(agentInput(running, { actions })), 'reasoning') as Extract<ModelEntry, { entries: unknown }>).entries as { id?: string; onSelect?(): void }[]).find((entry) => entry.id === 'max')!.onSelect!();
    expect(actions.calls).toEqual([['setEffort', [running.sessionId, 'max']]]);
  });

  it('offers to open its window when a click expands it, and the other way round', () => {
    expect(menuIds(agentMenu(agentInput(running, { clickOpens: 'expand' })))[0]).toBe('open-window');
    expect(menuIds(agentMenu(agentInput(running, { clickOpens: 'maximised' })))[0]).toBe('expand');
  });

  it('folds and restarts an ended agent, with nothing to pause', () => {
    const ids = menuIds(agentMenu(agentInput(ended)));
    expect(ids.slice(0, 4)).toEqual(['expand', 'pop-out', 'fold', 'restart']);
    expect(ids).not.toContain('pause');
  });

  it('resumes an agent stopped by a restart, and wakes a paused one', () => {
    expect(menuIds(agentMenu(agentInput({ ...galleryAgent('stopped-by-restart'), endedAt: AT })))).toContain('resume');
    expect(menuIds(agentMenu(agentInput({ ...galleryAgent('hibernated'), endedAt: AT })))).toContain('wake');
  });

  it('continues a rate-limited Claude agent on credits', () => {
    expect(menuIds(agentMenu(agentInput({ ...galleryAgent('rate-limited'), harness: 'claude' })))).toContain('continue-on-credits');
  });

  it('runs no gate without a worktree of its own, and none while one runs', () => {
    expect(menuIds(agentMenu(agentInput({ ...running, ownsWorktree: false })))).not.toContain('run-gate');
    const gate = row(agentMenu(agentInput(running, { gate: { status: 'running' } as GateRun })), 'run-gate');
    expect(gate).toMatchObject({ disabled: true, hint: 'It is running: its Gate tab shows it' });
  });

  it("opens a reviewer's review, and starts an implementer's next round", () => {
    expect(menuIds(agentMenu(agentInput({ ...running, reviewOf: 'impl' })))).toContain('open-review');
    expect(menuIds(agentMenu(agentInput({ ...running, reviewOf: 'impl' })))).not.toContain('start-review');
    const entries = agentMenu(agentInput(running, { rounds: [round('ready')] }));
    expect(menuIds(entries)).toContain('open-review');
    expect(row(entries, 'start-review')).toMatchObject({ label: 'Start review round 2', disabled: false });
    expect(row(agentMenu(agentInput(running, { rounds: [round('reviewing')] })), 'start-review')).toMatchObject({ disabled: true, hint: 'Round 1 is still under review.' });
  });

  it('says what its rows change to once set', () => {
    const entries = agentMenu(agentInput({ ...running, muted: true, issue: { id: 'X-1' } as Agent['issue'], schedule: {} as Agent['schedule'] }));
    expect(row(entries, 'mute').label).toBe('Unmute notifications');
    expect(row(entries, 'link-issue').label).toBe('Change issue…');
    expect(row(entries, 'schedule').label).toBe('Edit schedule…');
    expect(row(entries, 'delete')).toMatchObject({ label: 'Delete agent', danger: true });
  });

  it('calls the handler it was given', () => {
    const actions = spies<AgentMenuInput['actions']>();
    const entries = agentMenu(agentInput(running, { actions }));
    for (const id of ['expand', 'mute', 'delete']) (row(entries, id) as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['expand', ['n1']],
      ['setMuted', [running.sessionId, true]],
      ['deleteAgent', [running.sessionId]],
    ]);
  });
});

/** A tile's board handlers, remembering what was called into `calls`: none to connect or pin it unless given. */
function boardSpies(calls: [string, unknown[]][] = [], more: Partial<TileBoardActions> = {}): TileBoardActions {
  const remember = (name: string) => (...args: unknown[]) => void calls.push([name, args]);
  return { askClaude: remember('askClaude'), restack: remember('restack'), copy: remember('copy'), show: remember('show'), ...more };
}

function tileInput(agent: Agent, more: Partial<AgentTileMenuInput> = {}): AgentTileMenuInput {
  return { ...agentInput(agent), actions: spies(), board: boardSpies(), related: [], review: undefined, ...more };
}

/** The ids of a menu's top level alone. */
const topIds = (entries: readonly ModelEntry[]) => entries.flatMap((entry) => (entry === 'separator' || 'heading' in entry ? [] : [entry.id]));

describe("an agent tile's menu, grouped", () => {
  it("leads with how to open it, then groups its rows: run, settings, review and gate, arrange, ask, copy, delete", () => {
    const entries = agentTileMenu(tileInput(running));
    expect(topIds(entries)).toEqual(['expand', 'pop-out', 'run', 'settings', 'review', 'arrange', 'ask', 'copy', 'delete']);
    expect(menuIds(entries)).toEqual([
      'expand', 'pop-out',
      'run', 'run/interrupt', 'run/pause', 'run/stop',
      'settings', 'settings/rename', 'settings/schedule', 'settings/link-issue', 'settings/mute',
      'settings/reasoning', 'settings/reasoning/default', 'settings/reasoning/low', 'settings/reasoning/medium', 'settings/reasoning/high', 'settings/reasoning/xhigh', 'settings/reasoning/max',
      'review', 'review/open-pr', 'review/start-review', 'review/run-gate',
      'arrange', 'arrange/front', 'arrange/forward', 'arrange/backward', 'arrange/back', 'arrange/align',
      'ask',
      'copy', 'copy/branch', 'copy/worktree', 'copy/session-id',
      'delete',
    ]);
  });

  /** The rows of the submenu with this id. */
  const sub = (entries: readonly ModelEntry[], id: string) => (row(entries, id) as Extract<ModelEntry, { entries: unknown }>).entries;
  const paused: Agent = { ...galleryAgent('hibernated'), endedAt: AT };
  const asking: Agent = { ...galleryAgent('waiting'), ask: {} as Agent['ask'] };
  const reviewer: Agent = { ...galleryAgent('idle'), reviewOf: 'impl', pullRequests: [] };

  it('leads with its next step: where to answer its question, Wake while paused, a review once its doc is in', () => {
    expect(topIds(agentTileMenu(tileInput(asking)))[0]).toBe('go-to-question');
    expect(topIds(agentTileMenu(tileInput({ ...galleryAgent('needs-permission'), permissions: [{}] as Agent['permissions'] })))[0]).toBe('go-to-question');
    expect(topIds(agentTileMenu(tileInput(paused)))[0]).toBe('wake');
    expect(topIds(agentTileMenu(tileInput(reviewer, { review: { ...round('ready'), reviewer: reviewer.sessionId } })))[0]).toBe('open-review');
    // A paused reviewer with its doc in is woken first.
    expect(topIds(agentTileMenu(tileInput({ ...paused, reviewOf: 'impl' }, { review: round('ready') })))[0]).toBe('wake');
  });

  it('has no next step when nothing waits on the user: a turn that has ended, a review still being written', () => {
    expect(topIds(agentTileMenu(tileInput(galleryAgent('waiting'))))[0]).toBe('expand');
    expect(topIds(agentTileMenu(tileInput(running)))[0]).toBe('expand');
    expect(topIds(agentTileMenu(tileInput(reviewer, { review: round('reviewing') })))[0]).toBe('expand');
  });

  it('only opens the place to answer its question, the way a click on the tile does', () => {
    const actions = spies<AgentTileMenuInput['actions']>();
    (row(agentTileMenu(tileInput(asking, { actions })), 'go-to-question') as { onSelect(): void }).onSelect();
    (row(agentTileMenu(tileInput(asking, { actions, clickOpens: 'expand' })), 'go-to-question') as { onSelect(): void }).onSelect();
    expect(actions.calls.map(([name]) => name)).toEqual(['openAgent', 'expand']);
  });

  it('interrupts only mid-turn, and stops its session apart from the rest, as its window does', () => {
    expect(sub(agentTileMenu(tileInput(running)), 'run')).toMatchObject([
      { id: 'interrupt', label: 'Interrupt', disabled: false, hint: 'Interrupt what it is doing (Ctrl-C)' },
      { id: 'pause', label: 'Pause', disabled: true },
      'separator',
      { id: 'stop', label: 'Stop session', hint: 'End its session; its worktree and branch stay' },
    ]);
    expect(row(sub(agentTileMenu(tileInput(galleryAgent('idle'))), 'run'), 'interrupt')).toMatchObject({ disabled: true, hint: 'It has no turn under way to interrupt' });
  });

  it('stops a paused agent as it is, and carries an ended one on, with nothing to interrupt or stop', () => {
    expect(sub(agentTileMenu(tileInput(paused)), 'run')).toMatchObject([{ id: 'stop', hint: 'Close it as it is, no longer paused: its worktree and branch stay' }]);
    expect(menuIds(sub(agentTileMenu(tileInput(ended)), 'run'))).toEqual(['restart']);
    expect(menuIds(sub(agentTileMenu(tileInput({ ...galleryAgent('stopped-by-restart'), endedAt: AT })), 'run'))).toEqual(['resume']);
    expect(menuIds(sub(agentTileMenu(tileInput({ ...galleryAgent('rate-limited'), harness: 'claude' })), 'run'))).toContain('continue-on-credits');
  });

  it("has no Run for an ended reviewer, whose round ended with it", () => {
    expect(topIds(agentTileMenu(tileInput({ ...ended, reviewOf: 'impl' })))).not.toContain('run');
  });

  it('opens its own pull request, never one its work only went into', () => {
    const own = { number: 7, title: 'Fix the flake', url: '', state: 'open', checks: 'passing' } as Agent['pullRequests'][number];
    expect(row(sub(agentTileMenu(tileInput({ ...running, pullRequests: [own] })), 'review'), 'open-pr')).toMatchObject({ label: 'Open pull request #7', hint: 'Fix the flake' });
    expect(menuIds(sub(agentTileMenu(tileInput({ ...running, pullRequests: [], pushedPullRequests: [own] })), 'review'))).not.toContain('open-pr');
  });

  it('shows the tiles it is linked to', () => {
    const calls: [string, unknown[]][] = [];
    const entries = sub(
      agentTileMenu(tileInput(reviewer, { board: boardSpies(calls), related: [{ sessionId: 'impl', label: 'Show checkout-fix' }] })),
      'review',
    );
    expect(entries).toMatchObject([{ id: 'open-review' }, { id: 'show-impl', label: 'Show checkout-fix' }, 'separator', { id: 'run-gate' }]);
    (row(entries, 'show-impl') as { onSelect(): void }).onSelect();
    expect(calls).toEqual([['show', ['impl']]]);
  });

  it('arranges the tile: its z-order, Align for two or more, and where it sits', () => {
    const arrange = sub(agentTileMenu(tileInput(running)), 'arrange');
    expect(row(arrange, 'front')).toMatchObject({ label: 'Bring to front', shortcut: keyText('edit.front') });
    expect(row(arrange, 'align')).toMatchObject({ disabled: true, hint: 'Select two or more to line them up' });
    const placed = sub(agentTileMenu(tileInput(ended, { board: boardSpies([], { connect: () => {}, leadPin: { pinned: true, toggle: () => {} } }) })), 'arrange');
    expect(menuIds(placed).slice(-3)).toEqual(['fold', 'lead-pin', 'connect']);
    expect(row(placed, 'lead-pin').label).toBe('Free from top-left');
    expect(menuIds(sub(agentTileMenu(tileInput(running)), 'arrange'))).not.toContain('follow-rule');
    const calls: [string, unknown[]][] = [];
    const byHand = sub(agentTileMenu(tileInput(running, { board: boardSpies([], { backUnderRule: () => calls.push(['backUnderRule', []]) }) })), 'arrange');
    expect(row(byHand, 'follow-rule')).toMatchObject({ label: 'Put back under the rule', hint: "The zone's rule lays it out again" });
    (row(byHand, 'follow-rule') as { onSelect(): void }).onSelect();
    expect(calls).toEqual([['backUnderRule', []]]);
  });

  it('copies its branch name, worktree path and session id, and says when it has none', () => {
    const copy = sub(agentTileMenu(tileInput({ ...running, branch: '', worktree: '/w/fix' })), 'copy');
    expect(copy).toMatchObject([
      { label: 'Branch name', disabled: true, hint: 'It has none' },
      { label: 'Worktree path', detail: '/w/fix' },
      { label: 'Session id', detail: running.sessionId },
    ]);
  });

  it.each([
    ['running', running],
    ['asking', asking],
    ['paused', paused],
    ['ended', ended],
    ['an ended reviewer with its doc in', { ...ended, reviewOf: 'impl' }],
    ['a rate-limited Claude agent', { ...galleryAgent('rate-limited'), harness: 'claude' } as Agent],
  ])('has ten rows at most when %s', (_name, agent) => {
    const entries = agentTileMenu(tileInput(agent, { review: round('ready'), rounds: [round('ready')], related: [{ sessionId: 'x', label: 'Show x' }] }));
    expect(topIds(entries).length).toBeLessThanOrEqual(10);
    const ids = menuIds(entries);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("a shell's and an external session's menus", () => {
  it("lists a shell's rows", () => {
    const shell = { id: 's1' } as Shell;
    expect(menuIds(shellMenu({ nodeId: 'n1', shell, clickOpens: 'window', rename: () => {}, actions: spies() }))).toEqual(['expand', 'pop-out', 'rename', 'delete']);
  });

  it("lists an external session's rows", () => {
    expect(menuIds(externalMenu({ id: 'e1' } as ExternalSession, spies()))).toEqual(['resume', 'delete']);
  });
});

const repoZone: Zone = {
  id: 'z1',
  kind: 'repo',
  repoRoot: '/code/acme',
  folder: '',
  name: 'acme',
  color: ZONE_COLORS[2]!,
  fillOpacity: null,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  codexBypassHookTrust: false,
  trustsFolder: false,
  boardMcp: true,
  agentsOrchestrate: false,
  gateCommand: null,
  tracker: null,
  spacing: 'normal',
  layoutMode: 'free',
  layoutRule: 'off',
  handPlaced: [],
  folded: false,
  clone: null,
  managedClone: false,
  defaultRepo: null,
  groupFolder: null,
  userFolder: false,
  createdAt: AT,
};
const group: Zone = { ...repoZone, kind: 'unbound', repoRoot: null };

function zoneInput(zone: Zone, more: Partial<ZoneMenuInput> = {}): ZoneMenuInput {
  return { zone, folded: [], themeFill: 8, rename: () => {}, actions: spies(), ...more };
}

describe("a zone's ⋯ menu", () => {
  it("lists a repo zone's rows, in order", () => {
    expect(menuIds(zoneMenu(zoneInput(repoZone)))).toEqual([
      'crew',
      'crew/crew-library',
      'tidy',
      'spacing',
      'spacing/layout-free',
      'spacing/layout-lanes',
      'spacing/layout-shelves',
      'spacing/layout-clusters',
      'spacing/spacing-compact',
      'spacing/spacing-normal',
      'spacing/spacing-roomy',
      'fold',
      'rename',
      'colour',
      'fill-opacity',
      'unbind',
      'trust-folder',
      'board-mcp',
      'orchestrate',
      'gate-command',
      'role-templates',
      'delete',
    ]);
  });

  it("gives a group a default repo in place of Unbind, and a user's folder git init, with no folder to trust", () => {
    const ids = menuIds(zoneMenu(zoneInput({ ...group, userFolder: true })));
    expect(ids).toContain('default-repo');
    expect(ids).toContain('init-repo');
    expect(ids).not.toContain('unbind');
    expect(ids).not.toContain('trust-folder');
  });

  it('leads with the chips folded off its tab', () => {
    const folded: ModelEntry[] = [{ id: 'tab-new-agent', label: 'New agent', onSelect: () => {} }];
    const entries = zoneMenu(zoneInput(repoZone, { folded }));
    expect(menuIds(entries).slice(0, 4)).toEqual(['tab-new-agent', 'crew', 'crew/crew-library', 'tidy']);
    expect(entries[2]).toBe('separator');
  });

  it('offers a crew from each prefab in the library, yours first, and the library itself', () => {
    library.current = [
      { name: 'Solo agent', icon: 'agent', builtIn: true, members: [] },
      { name: 'Docs pass', icon: 'review', builtIn: false, members: [] },
    ] as unknown as LibraryPrefab[];
    const actions = spies<ProjectContextMenuInput['actions']>();
    const crew = row(zoneMenu(zoneInput(repoZone, { actions })), 'crew') as { entries: ModelEntry[] };
    library.current = [];
    expect(menuIds(crew.entries)).toEqual(['crew-Docs pass', 'crew-Solo agent', 'crew-library']);
    // A line between yours and the built-ins, and before the library.
    expect(crew.entries.filter((entry) => entry === 'separator')).toHaveLength(2);
    (row(crew.entries, 'crew-Docs pass') as { onSelect(): void }).onSelect();
    (row(crew.entries, 'crew-library') as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['startCrew', ['Docs pass', repoZone]],
      ['crewLibrary', [repoZone]],
    ]);
  });

  it('holds only what folded while it clones', () => {
    const folded: ModelEntry[] = [{ id: 'tab-cancel-clone', label: 'Cancel clone', onSelect: () => {} }];
    expect(zoneMenu(zoneInput({ ...repoZone, clone: {} as Zone['clone'] }, { folded }))).toEqual(folded);
  });

  it('fills from the theme until it has a fill of its own', () => {
    expect(row(zoneMenu(zoneInput(repoZone)), 'fill-opacity')).toMatchObject({ value: 8 });
    expect(row(zoneMenu(zoneInput({ ...repoZone, fillOpacity: 30 })), 'fill-opacity')).toMatchObject({ value: 30 });
  });

  it('calls the handler it was given', () => {
    const actions = spies<ProjectContextMenuInput['actions']>();
    const entries = zoneMenu(zoneInput(repoZone, { actions }));
    for (const id of ['tidy', 'board-mcp', 'delete']) (row(entries, id) as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['tidy', [repoZone]],
      ['setBoardMcp', [repoZone, false]],
      ['deleteZone', [repoZone]],
    ]);
  });
});

describe("a zone's tab chips, folded into ⋯", () => {
  const ids = (zone: Zone) =>
    Object.entries(zoneTabEntries(zone, undefined, spies()))
      .filter(([, entry]) => entry !== undefined)
      .map(([chip]) => chip);

  it("offers a repo zone's tracker, new agent and shell, with Tidy left to ⋯", () => {
    expect(ids(repoZone)).toEqual(['tracker', 'agent', 'shell']);
  });

  it("offers a group's binding and default repo, a tracker's issues, and a clone's Cancel and Tidy", () => {
    expect(ids({ ...group, defaultRepo: '/code/web' })).toEqual(['default-repo', 'tracker', 'bind', 'agent', 'shell']);
    expect(ids({ ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'] })).toContain('issue');
    expect(ids({ ...repoZone, clone: {} as Zone['clone'] })).toEqual(['cancel-clone', 'tracker', 'agent', 'shell', 'tidy']);
  });

  it("says why a zone can't start agents", () => {
    expect(zoneTabEntries(repoZone, 'Still cloning', spies()).agent).toMatchObject({ disabled: true, hint: 'Still cloning' });
  });
});

describe("a zone's tab menus", () => {
  it('disables every Tidy on status shelves, saying why: it would move the tiles folded into stacks', () => {
    const shelved = { ...repoZone, layoutMode: 'shelves' as const };
    const why = { disabled: true, hint: expect.stringMatching(/folded into stacks/) };
    expect(row(tidyMenu(shelved, undefined, spies()), 'tidy')).toMatchObject(why);
    expect(row(zoneMenu(zoneInput(shelved)), 'tidy')).toMatchObject(why);
    expect(row(tidyMenu({ ...repoZone, layoutMode: 'clusters' }, undefined, spies()), 'tidy')).toMatchObject({ disabled: true, hint: expect.stringMatching(/lays its tiles out itself/) });
    expect(row(tidyMenu(repoZone, undefined, spies()), 'tidy')).not.toHaveProperty('disabled');
    const ruled = { ...repoZone, layoutRule: 'lanes' as const };
    expect(row(tidyMenu(ruled, undefined, spies()), 'tidy')).toMatchObject({ disabled: true, hint: 'The zone lays its tiles out by its rule' });
    expect(row(zoneMenu(zoneInput(ruled)), 'tidy')).toMatchObject({ disabled: true });
  });

  it('offers the rule and the views in one Layout list, the one in use ticked', () => {
    const layouts = (zone: Zone) => tidyMenu(zone, undefined, spies()).filter((entry) => typeof entry === 'object' && 'id' in entry && entry.id.startsWith('layout-'));
    expect(layouts(repoZone)).toMatchObject([
      { id: 'layout-free', label: 'Free', checked: true },
      { id: 'layout-lanes', label: 'Lanes by ticket', hint: 'A lane per ticket, kept as work comes and goes', checked: false },
      { id: 'layout-shelves', label: 'Status shelves', checked: false },
      { id: 'layout-clusters', label: 'Clusters', checked: false },
    ]);
    expect(layouts({ ...repoZone, layoutRule: 'lanes' }).map((entry) => (entry as { checked: boolean }).checked)).toEqual([false, true, false, false]);
  });

  it('lists Tidy ▾: Tidy now, its layouts, its spacings, and the spacing for new zones', () => {
    expect(menuIds(tidyMenu(repoZone, undefined, spies()))).toEqual(['tidy', 'layout-free', 'layout-lanes', 'layout-shelves', 'layout-clusters', 'spacing-compact', 'spacing-normal', 'spacing-roomy', 'new-zone-spacing']);
    expect(row(tidyMenu(repoZone, 'roomy', spies()), 'new-zone-spacing')).toMatchObject({ detail: 'Roomy · Settings' });
  });

  it("lists a group's ways to be bound, in the tab's Bind… and its folded row alike", () => {
    expect(menuIds(bindEntries(group, spies()))).toEqual(['repo', 'project', 'tracker']);
    expect(menuIds([zoneTabEntries(group, undefined, spies()).bind!])).toEqual(['tab-bind', 'tab-bind/repo', 'tab-bind/project', 'tab-bind/tracker']);
  });
});

/** The key a shortcut is, by its id in the key registry: the same on every platform. */
const SHORTCUTS = new Map([
  [keyText('tile.rename'), 'tile.rename'],
  [runGateShortcut(), 'window.runGate'],
]);

/**
 * What each row says and how it is drawn, without its icon or handler: its id and label, and its shortcut, enabled
 * rule, danger flag, hint, choice and detail where it has them. Submenus are shown in full.
 */
function fields(entries: readonly ModelEntry[]): unknown[] {
  return entries.map((entry) => {
    if (entry === 'separator' || 'heading' in entry) return entry;
    const shown: Record<string, unknown> = { id: entry.id, label: entry.label };
    if ('shortcut' in entry && entry.shortcut !== undefined) shown.shortcut = SHORTCUTS.get(entry.shortcut) ?? entry.shortcut;
    for (const key of ['disabled', 'danger', 'hint', 'checked', 'detail'] as const) {
      if (key in entry && (entry as Record<string, unknown>)[key] !== undefined) shown[key] = (entry as Record<string, unknown>)[key];
    }
    if ('entries' in entry) shown.entries = fields(entry.entries);
    if ('swatches' in entry) shown.swatches = { count: entry.swatches.length, pressed: entry.swatches.filter((swatch) => swatch.pressed).map((swatch) => swatch.name) };
    if ('onCommit' in entry) shown.slider = { value: entry.value, min: entry.min, max: entry.max, step: entry.step, shown: entry.format(entry.value) };
    return shown;
  });
}

/** The zone's ⋯ with every chip of its tab folded into it, the most needed first, as the tab folds them. */
function foldedZoneMenu(zone: Zone): ModelEntry[] {
  const tab = zoneTabEntries(zone, undefined, spies());
  const order = ['cancel-clone', 'agent', 'shell', 'default-repo', 'bind', 'tracker', 'issue', 'tidy'] as const;
  return zoneMenu(zoneInput(zone, { folded: order.flatMap((chip) => (tab[chip] === undefined ? [] : [tab[chip]])) }));
}

describe("every row's fields", () => {
  it("pins a running agent's menu", () => {
    expect(fields(agentMenu(agentInput(running)))).toMatchInlineSnapshot(`
      [
        {
          "id": "expand",
          "label": "Expand in place",
        },
        {
          "id": "pop-out",
          "label": "Pop out",
        },
        {
          "disabled": true,
          "hint": "It is mid-turn: finish its turn first",
          "id": "pause",
          "label": "Pause",
        },
        "separator",
        {
          "id": "rename",
          "label": "Rename",
          "shortcut": "tile.rename",
        },
        {
          "id": "schedule",
          "label": "Schedule…",
        },
        {
          "id": "link-issue",
          "label": "Link issue…",
        },
        {
          "id": "mute",
          "label": "Mute notifications",
        },
        {
          "detail": "Default",
          "entries": [
            {
              "heading": "Typed at its prompt between turns",
            },
            {
              "hint": "Applies when the agent restarts",
              "id": "default",
              "label": "Default",
            },
            {
              "hint": "Fastest, least usage",
              "id": "low",
              "label": "Low",
            },
            {
              "id": "medium",
              "label": "Medium",
            },
            {
              "id": "high",
              "label": "High",
            },
            {
              "id": "xhigh",
              "label": "Extra high",
            },
            {
              "hint": "Slowest, most usage",
              "id": "max",
              "label": "Max",
            },
          ],
          "id": "reasoning",
          "label": "Reasoning",
        },
        "separator",
        {
          "disabled": false,
          "id": "start-review",
          "label": "Review its work",
        },
        {
          "disabled": false,
          "hint": "Run its zone's gate command in its worktree",
          "id": "run-gate",
          "label": "Run gate",
          "shortcut": "window.runGate",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Delete agent",
        },
      ]
    `);
  });

  it("pins an idle agent's menu, with a gate running", () => {
    expect(fields(agentMenu(agentInput(galleryAgent('idle'), { gate: { status: 'running' } as GateRun, rounds: [round('ready')] })))).toMatchInlineSnapshot(`
      [
        {
          "id": "expand",
          "label": "Expand in place",
        },
        {
          "id": "pop-out",
          "label": "Pop out",
        },
        {
          "disabled": false,
          "hint": "Hibernate it to free its memory: Wake, or a message, starts it again in its conversation",
          "id": "pause",
          "label": "Pause",
        },
        "separator",
        {
          "id": "rename",
          "label": "Rename",
          "shortcut": "tile.rename",
        },
        {
          "id": "schedule",
          "label": "Schedule…",
        },
        {
          "id": "link-issue",
          "label": "Link issue…",
        },
        {
          "id": "mute",
          "label": "Mute notifications",
        },
        {
          "detail": "Default",
          "entries": [
            {
              "heading": "Applies when the agent restarts",
            },
            {
              "id": "default",
              "label": "Default",
            },
            {
              "hint": "Fastest, least usage",
              "id": "low",
              "label": "Low",
            },
            {
              "id": "medium",
              "label": "Medium",
            },
            {
              "id": "high",
              "label": "High",
            },
            {
              "id": "xhigh",
              "label": "Extra high",
            },
          ],
          "id": "reasoning",
          "label": "Reasoning",
        },
        "separator",
        {
          "id": "open-review",
          "label": "Open review",
        },
        {
          "disabled": false,
          "id": "start-review",
          "label": "Start review round 2",
        },
        {
          "disabled": true,
          "hint": "It is running: its Gate tab shows it",
          "id": "run-gate",
          "label": "Run gate",
          "shortcut": "window.runGate",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Delete agent",
        },
      ]
    `);
  });

  it("pins an ended agent's menu, and a paused one's", () => {
    expect(fields(agentMenu(agentInput(ended)))).toMatchInlineSnapshot(`
      [
        {
          "id": "expand",
          "label": "Expand in place",
        },
        {
          "id": "pop-out",
          "label": "Pop out",
        },
        {
          "id": "fold",
          "label": "Fold to a chip",
        },
        {
          "id": "restart",
          "label": "Restart agent",
        },
        "separator",
        {
          "id": "rename",
          "label": "Rename",
          "shortcut": "tile.rename",
        },
        {
          "id": "schedule",
          "label": "Schedule…",
        },
        {
          "id": "link-issue",
          "label": "Link issue…",
        },
        {
          "id": "mute",
          "label": "Mute notifications",
        },
        {
          "detail": "Default",
          "entries": [
            {
              "heading": "Applies when the agent restarts",
            },
            {
              "id": "default",
              "label": "Default",
            },
            {
              "hint": "Fastest, least usage",
              "id": "low",
              "label": "Low",
            },
            {
              "id": "medium",
              "label": "Medium",
            },
            {
              "id": "high",
              "label": "High",
            },
            {
              "id": "xhigh",
              "label": "Extra high",
            },
            {
              "hint": "Slowest, most usage",
              "id": "max",
              "label": "Max",
            },
          ],
          "id": "reasoning",
          "label": "Reasoning",
        },
        "separator",
        {
          "disabled": false,
          "id": "start-review",
          "label": "Review its work",
        },
        {
          "disabled": false,
          "hint": "Run its zone's gate command in its worktree",
          "id": "run-gate",
          "label": "Run gate",
          "shortcut": "window.runGate",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Delete agent",
        },
      ]
    `);
    expect(fields(agentMenu(agentInput({ ...galleryAgent('hibernated'), endedAt: AT })))).toMatchInlineSnapshot(`
      [
        {
          "id": "expand",
          "label": "Expand in place",
        },
        {
          "id": "pop-out",
          "label": "Pop out",
        },
        {
          "hint": "Start it again, carrying on its conversation",
          "id": "wake",
          "label": "Wake",
        },
        "separator",
        {
          "id": "rename",
          "label": "Rename",
          "shortcut": "tile.rename",
        },
        {
          "id": "schedule",
          "label": "Schedule…",
        },
        {
          "id": "link-issue",
          "label": "Link issue…",
        },
        {
          "id": "mute",
          "label": "Mute notifications",
        },
        {
          "detail": "Default",
          "entries": [
            {
              "heading": "Applies when the agent restarts",
            },
            {
              "id": "default",
              "label": "Default",
            },
            {
              "hint": "Fastest, least usage",
              "id": "low",
              "label": "Low",
            },
            {
              "id": "medium",
              "label": "Medium",
            },
            {
              "id": "high",
              "label": "High",
            },
            {
              "id": "xhigh",
              "label": "Extra high",
            },
            {
              "hint": "Slowest, most usage",
              "id": "max",
              "label": "Max",
            },
          ],
          "id": "reasoning",
          "label": "Reasoning",
        },
        "separator",
        {
          "disabled": false,
          "id": "start-review",
          "label": "Review its work",
        },
        {
          "disabled": false,
          "hint": "Run its zone's gate command in its worktree",
          "id": "run-gate",
          "label": "Run gate",
          "shortcut": "window.runGate",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Delete agent",
        },
      ]
    `);
  });

  it("pins a shell's and an external session's menus", () => {
    expect(fields(shellMenu({ nodeId: 'n1', shell: { id: 's1' } as Shell, clickOpens: 'expand', rename: () => {}, actions: spies() }))).toMatchInlineSnapshot(`
      [
        {
          "id": "open-window",
          "label": "Open window",
        },
        {
          "id": "pop-out",
          "label": "Pop out",
        },
        "separator",
        {
          "id": "rename",
          "label": "Rename",
          "shortcut": "tile.rename",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Delete shell",
        },
      ]
    `);
    expect(fields(externalMenu({ id: 'e1' } as ExternalSession, spies()))).toMatchInlineSnapshot(`
      [
        {
          "id": "resume",
          "label": "Resume in agent-board…",
        },
        "separator",
        {
          "danger": true,
          "id": "delete",
          "label": "Remove from board",
        },
      ]
    `);
  });

  it("pins a repo zone's ⋯, everything on its tab folded in", () => {
    expect(fields(foldedZoneMenu({ ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'], gateCommand: 'pnpm check', trustsFolder: true }))).toMatchInlineSnapshot(`
      [
        {
          "disabled": false,
          "id": "tab-new-agent",
          "label": "New agent",
        },
        {
          "id": "tab-new-shell",
          "label": "New shell",
        },
        {
          "entries": [
            {
              "id": "crew-library",
              "label": "Library…",
            },
          ],
          "id": "crew",
          "label": "New crew",
        },
        {
          "id": "tab-tracker",
          "label": "Issues from acme/web…",
        },
        {
          "id": "tab-add-issue",
          "label": "Add issue…",
        },
        "separator",
        {
          "hint": "Its tiles in rows, in reading order",
          "id": "tidy",
          "label": "Tidy",
        },
        {
          "entries": [
            {
              "heading": "Layout",
            },
            {
              "checked": true,
              "hint": "Each tile where you put it",
              "id": "layout-free",
              "label": "Free",
            },
            {
              "checked": false,
              "hint": "A lane per ticket, kept as work comes and goes",
              "id": "layout-lanes",
              "label": "Lanes by ticket",
            },
            {
              "checked": false,
              "hint": "Shelves by status, a stack per ticket",
              "id": "layout-shelves",
              "label": "Status shelves",
            },
            {
              "checked": false,
              "hint": "Each ticket's tiles together, what needs you first",
              "id": "layout-clusters",
              "label": "Clusters",
            },
            "separator",
            {
              "heading": "Spacing",
            },
            {
              "checked": false,
              "detail": "8 · 32",
              "id": "spacing-compact",
              "label": "Compact",
            },
            {
              "checked": true,
              "detail": "16 · 40",
              "id": "spacing-normal",
              "label": "Normal",
            },
            {
              "checked": false,
              "detail": "32 · 64",
              "id": "spacing-roomy",
              "label": "Roomy",
            },
          ],
          "id": "spacing",
          "label": "Layout and spacing",
        },
        {
          "hint": "Pauses the agents that can pause and lets their terminals go, to free memory. The chip keeps a count and anything that needs you",
          "id": "fold",
          "label": "Fold to a chip",
        },
        {
          "id": "rename",
          "label": "Rename",
        },
        {
          "id": "colour",
          "label": "Colour",
          "swatches": {
            "count": 16,
            "pressed": [
              "Amber",
            ],
          },
        },
        {
          "id": "fill-opacity",
          "label": "Fill opacity",
          "slider": {
            "max": 40,
            "min": 0,
            "shown": "8%",
            "step": 2,
            "value": 8,
          },
        },
        {
          "hint": "Its agents keep their repos, and it keeps its issues",
          "id": "unbind",
          "label": "Unbind",
        },
        {
          "hint": "New agents show Claude's trust prompt again, for you to answer",
          "id": "trust-folder",
          "label": "Stop trusting this zone's folder",
        },
        {
          "hint": "Agents started here stop getting the agent-board MCP server; the CLI stays",
          "id": "board-mcp",
          "label": "Turn off board MCP",
        },
        {
          "hint": "Agents you start here may start, message and close agents in this zone",
          "id": "orchestrate",
          "label": "Let agents orchestrate",
        },
        {
          "hint": "pnpm check",
          "id": "gate-command",
          "label": "Change the gate command…",
        },
        {
          "hint": "What agents started here in a role begin with",
          "id": "role-templates",
          "label": "Role templates…",
        },
        "separator",
        {
          "danger": true,
          "hint": "Its tiles stay on the board where they are",
          "id": "delete",
          "label": "Delete zone…",
        },
      ]
    `);
  });

  it("pins a group's ⋯, with a default repo and a user's folder, everything on its tab folded in", () => {
    expect(fields(foldedZoneMenu({ ...group, defaultRepo: '/code/web', userFolder: true, fillOpacity: 30 }))).toMatchInlineSnapshot(`
      [
        {
          "disabled": false,
          "id": "tab-new-agent",
          "label": "New agent",
        },
        {
          "id": "tab-new-shell",
          "label": "New shell",
        },
        {
          "entries": [
            {
              "id": "crew-library",
              "label": "Library…",
            },
          ],
          "id": "crew",
          "label": "New crew",
        },
        {
          "hint": "The default repo: new agents here start in it",
          "id": "tab-default-repo",
          "label": "web",
        },
        {
          "entries": [
            {
              "id": "repo",
              "label": "Open as repo…",
            },
            {
              "id": "project",
              "label": "Open as project…",
            },
            {
              "id": "tracker",
              "label": "Bind to a Linear team or GitHub repo…",
            },
          ],
          "id": "tab-bind",
          "label": "Bind…",
        },
        {
          "id": "tab-tracker",
          "label": "Pick where issues come from…",
        },
        "separator",
        {
          "hint": "Its tiles in rows, in reading order",
          "id": "tidy",
          "label": "Tidy",
        },
        {
          "entries": [
            {
              "heading": "Layout",
            },
            {
              "checked": true,
              "hint": "Each tile where you put it",
              "id": "layout-free",
              "label": "Free",
            },
            {
              "checked": false,
              "hint": "A lane per ticket, kept as work comes and goes",
              "id": "layout-lanes",
              "label": "Lanes by ticket",
            },
            {
              "checked": false,
              "hint": "Shelves by status, a stack per ticket",
              "id": "layout-shelves",
              "label": "Status shelves",
            },
            {
              "checked": false,
              "hint": "Each ticket's tiles together, what needs you first",
              "id": "layout-clusters",
              "label": "Clusters",
            },
            "separator",
            {
              "heading": "Spacing",
            },
            {
              "checked": false,
              "detail": "8 · 32",
              "id": "spacing-compact",
              "label": "Compact",
            },
            {
              "checked": true,
              "detail": "16 · 40",
              "id": "spacing-normal",
              "label": "Normal",
            },
            {
              "checked": false,
              "detail": "32 · 64",
              "id": "spacing-roomy",
              "label": "Roomy",
            },
          ],
          "id": "spacing",
          "label": "Layout and spacing",
        },
        {
          "hint": "Pauses the agents that can pause and lets their terminals go, to free memory. The chip keeps a count and anything that needs you",
          "id": "fold",
          "label": "Fold to a chip",
        },
        {
          "id": "rename",
          "label": "Rename",
        },
        {
          "id": "colour",
          "label": "Colour",
          "swatches": {
            "count": 16,
            "pressed": [
              "Amber",
            ],
          },
        },
        {
          "id": "fill-opacity",
          "label": "Fill opacity",
          "slider": {
            "max": 40,
            "min": 0,
            "shown": "30%",
            "step": 2,
            "value": 30,
          },
        },
        {
          "hint": "New agents here start in it without asking",
          "id": "default-repo",
          "label": "Change the default repo…",
        },
        {
          "hint": "git init, with no commit: new agents then get worktrees of their own",
          "id": "init-repo",
          "label": "Make it a git repo",
        },
        {
          "hint": "Agents started here stop getting the agent-board MCP server; the CLI stays",
          "id": "board-mcp",
          "label": "Turn off board MCP",
        },
        {
          "hint": "Agents you start here may start, message and close agents in this zone",
          "id": "orchestrate",
          "label": "Let agents orchestrate",
        },
        {
          "hint": "What checks an agent's work before it is merged, run when you ask",
          "id": "gate-command",
          "label": "Set a gate command…",
        },
        {
          "hint": "What agents started here in a role begin with",
          "id": "role-templates",
          "label": "Role templates…",
        },
        "separator",
        {
          "danger": true,
          "hint": "Its tiles stay on the board where they are",
          "id": "delete",
          "label": "Delete zone…",
        },
      ]
    `);
  });

  it("pins a cloning zone's ⋯, everything on its tab folded in", () => {
    expect(fields(foldedZoneMenu({ ...repoZone, clone: {} as Zone['clone'] }))).toMatchInlineSnapshot(`
      [
        {
          "danger": true,
          "id": "tab-cancel-clone",
          "label": "Cancel clone",
        },
        {
          "disabled": false,
          "id": "tab-new-agent",
          "label": "New agent",
        },
        {
          "id": "tab-new-shell",
          "label": "New shell",
        },
        {
          "id": "tab-tracker",
          "label": "Pick where issues come from…",
        },
        {
          "id": "tab-tidy",
          "label": "Tidy",
        },
      ]
    `);
  });

  it("pins the tab's Tidy ▾, a zone's tab menus, and Bind…", () => {
    expect(fields(tidyMenu(repoZone, 'roomy', spies()))).toMatchInlineSnapshot(`
      [
        {
          "id": "tidy",
          "label": "Tidy now",
        },
        "separator",
        {
          "heading": "Layout",
        },
        {
          "checked": true,
          "hint": "Each tile where you put it",
          "id": "layout-free",
          "label": "Free",
        },
        {
          "checked": false,
          "hint": "A lane per ticket, kept as work comes and goes",
          "id": "layout-lanes",
          "label": "Lanes by ticket",
        },
        {
          "checked": false,
          "hint": "Shelves by status, a stack per ticket",
          "id": "layout-shelves",
          "label": "Status shelves",
        },
        {
          "checked": false,
          "hint": "Each ticket's tiles together, what needs you first",
          "id": "layout-clusters",
          "label": "Clusters",
        },
        "separator",
        {
          "heading": "Spacing in this zone",
        },
        {
          "checked": false,
          "detail": "8 · 32",
          "id": "spacing-compact",
          "label": "Compact",
        },
        {
          "checked": true,
          "detail": "16 · 40",
          "id": "spacing-normal",
          "label": "Normal",
        },
        {
          "checked": false,
          "detail": "32 · 64",
          "id": "spacing-roomy",
          "label": "Roomy",
        },
        "separator",
        {
          "detail": "Roomy · Settings",
          "id": "new-zone-spacing",
          "label": "Default for new zones…",
        },
      ]
    `);
    expect(fields(bindEntries(group, spies()))).toMatchInlineSnapshot(`
      [
        {
          "id": "repo",
          "label": "Open as repo…",
        },
        {
          "id": "project",
          "label": "Open as project…",
        },
        {
          "id": "tracker",
          "label": "Bind to a Linear team or GitHub repo…",
        },
      ]
    `);
  });
});

describe('row ids', () => {
  it.each([
    ['a repo zone', { ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'] }],
    ['a group with a default repo and a tracker', { ...group, defaultRepo: '/code/web', userFolder: true, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'] }],
    ['a cloning zone', { ...repoZone, clone: {} as Zone['clone'] }],
  ])("are unique in %s's ⋯, everything on its tab folded in", (_name, zone) => {
    const ids = menuIds(foldedZoneMenu(zone));
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('are unique in every agent menu', () => {
    for (const agent of [running, ended, { ...galleryAgent('stopped-by-restart'), endedAt: AT }, { ...running, reviewOf: 'impl' }]) {
      const ids = menuIds(agentMenu(agentInput(agent, { rounds: [round('ready')] })));
      expect(ids.length).toBe(new Set(ids).size);
    }
  });
});

/** Each action row selected in turn, with the handler it called and what with: submenu rows as `submenu/row`. */
function wiring(entries: readonly ModelEntry[], calls: [string, unknown[]][], prefix = ''): string[] {
  return entries.flatMap((entry) => {
    if (entry === 'separator' || 'heading' in entry) return [];
    if ('entries' in entry) return wiring(entry.entries, calls, `${prefix}${entry.id}/`);
    const before = calls.length;
    if ('onSelect' in entry) entry.onSelect();
    else if ('onPick' in entry) entry.onPick('picked');
    else entry.onCommit(12);
    const made = calls.slice(before).map(([name, args]) => `${name}(${args.map((arg) => (typeof arg === 'object' && arg !== null ? `#${String('sessionId' in arg ? arg.sessionId : 'id' in arg ? arg.id : '?')}` : JSON.stringify(arg))).join(', ')})`);
    return [`${prefix}${entry.id} → ${made.join(', ') || 'nothing'}`];
  });
}

describe("every row's handler", () => {
  it("is wired in an agent's menu", () => {
    const actions = spies<AgentMenuInput['actions']>();
    const rename = () => void actions.calls.push(['rename', []]);
    const agent = { ...galleryAgent('idle'), sessionId: 'a1' };
    expect([
      ...wiring(agentMenu(agentInput(agent, { actions, rename, rounds: [round('ready')] })), actions.calls),
      ...wiring(agentMenu(agentInput({ ...agent, reviewOf: 'impl' }, { actions, rename, clickOpens: 'expand' })), actions.calls),
      ...wiring(agentMenu(agentInput({ ...ended, sessionId: 'a2' }, { actions, rename })), actions.calls),
      ...wiring(agentMenu(agentInput({ ...galleryAgent('stopped-by-restart'), sessionId: 'a3', endedAt: AT }, { actions, rename })), actions.calls),
      ...wiring(agentMenu(agentInput({ ...galleryAgent('hibernated'), sessionId: 'a4', endedAt: AT }, { actions, rename })), actions.calls),
      ...wiring(agentMenu(agentInput({ ...galleryAgent('rate-limited'), sessionId: 'a5', harness: 'claude' }, { actions, rename })), actions.calls),
    ]).toMatchInlineSnapshot(`
      [
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a1)",
        "pause → pauseAgent("a1")",
        "rename → rename()",
        "schedule → scheduleAgent(#a1)",
        "link-issue → linkIssue(#a1)",
        "mute → setMuted("a1", true)",
        "reasoning/default → setEffort("a1", null)",
        "reasoning/low → setEffort("a1", "low")",
        "reasoning/medium → setEffort("a1", "medium")",
        "reasoning/high → setEffort("a1", "high")",
        "reasoning/xhigh → setEffort("a1", "xhigh")",
        "open-review → openReview("a1")",
        "start-review → startReview(#a1)",
        "run-gate → openGate(#a1, true)",
        "delete → deleteAgent("a1")",
        "open-window → openAgent(#a1)",
        "pop-out → popOutAgent(#a1)",
        "pause → pauseAgent("a1")",
        "rename → rename()",
        "schedule → scheduleAgent(#a1)",
        "link-issue → linkIssue(#a1)",
        "mute → setMuted("a1", true)",
        "reasoning/default → setEffort("a1", null)",
        "reasoning/low → setEffort("a1", "low")",
        "reasoning/medium → setEffort("a1", "medium")",
        "reasoning/high → setEffort("a1", "high")",
        "reasoning/xhigh → setEffort("a1", "xhigh")",
        "open-review → openReview("impl")",
        "run-gate → openGate(#a1, true)",
        "delete → deleteAgent("a1")",
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a2)",
        "fold → setFolded("n1", true)",
        "restart → restartAgent("a2")",
        "rename → rename()",
        "schedule → scheduleAgent(#a2)",
        "link-issue → linkIssue(#a2)",
        "mute → setMuted("a2", true)",
        "reasoning/default → setEffort("a2", null)",
        "reasoning/low → setEffort("a2", "low")",
        "reasoning/medium → setEffort("a2", "medium")",
        "reasoning/high → setEffort("a2", "high")",
        "reasoning/xhigh → setEffort("a2", "xhigh")",
        "reasoning/max → setEffort("a2", "max")",
        "start-review → startReview(#a2)",
        "run-gate → openGate(#a2, true)",
        "delete → deleteAgent("a2")",
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a3)",
        "resume → resumeAgent("a3")",
        "rename → rename()",
        "schedule → scheduleAgent(#a3)",
        "link-issue → linkIssue(#a3)",
        "mute → setMuted("a3", true)",
        "reasoning/default → setEffort("a3", null)",
        "reasoning/low → setEffort("a3", "low")",
        "reasoning/medium → setEffort("a3", "medium")",
        "reasoning/high → setEffort("a3", "high")",
        "reasoning/xhigh → setEffort("a3", "xhigh")",
        "start-review → startReview(#a3)",
        "run-gate → openGate(#a3, true)",
        "delete → deleteAgent("a3")",
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a4)",
        "wake → resumeAgent("a4")",
        "rename → rename()",
        "schedule → scheduleAgent(#a4)",
        "link-issue → linkIssue(#a4)",
        "mute → setMuted("a4", true)",
        "reasoning/default → setEffort("a4", null)",
        "reasoning/low → setEffort("a4", "low")",
        "reasoning/medium → setEffort("a4", "medium")",
        "reasoning/high → setEffort("a4", "high")",
        "reasoning/xhigh → setEffort("a4", "xhigh")",
        "reasoning/max → setEffort("a4", "max")",
        "start-review → startReview(#a4)",
        "run-gate → openGate(#a4, true)",
        "delete → deleteAgent("a4")",
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a5)",
        "continue-on-credits → continueOnCredits("a5")",
        "pause → pauseAgent("a5")",
        "rename → rename()",
        "schedule → scheduleAgent(#a5)",
        "link-issue → linkIssue(#a5)",
        "mute → setMuted("a5", true)",
        "reasoning/default → setEffort("a5", null)",
        "reasoning/low → setEffort("a5", "low")",
        "reasoning/medium → setEffort("a5", "medium")",
        "reasoning/high → setEffort("a5", "high")",
        "reasoning/xhigh → setEffort("a5", "xhigh")",
        "reasoning/max → setEffort("a5", "max")",
        "start-review → startReview(#a5)",
        "run-gate → openGate(#a5, true)",
        "delete → deleteAgent("a5")",
      ]
    `);
  });

  it("is wired in an agent tile's menu", () => {
    const actions = spies<AgentTileMenuInput['actions']>();
    const board = boardSpies(actions.calls, { connect: () => void actions.calls.push(['connect', []]), leadPin: { pinned: false, toggle: () => void actions.calls.push(['toggleLeadPin', []]) } });
    const rename = () => void actions.calls.push(['rename', []]);
    const pr = { number: 9, title: 'Fix', url: '', state: 'open', checks: 'passing' } as Agent['pullRequests'][number];
    const agent: Agent = { ...galleryAgent('waiting'), sessionId: 'a1', ask: {} as Agent['ask'], pullRequests: [pr] };
    expect([
      ...wiring(agentTileMenu(tileInput(agent, { actions, board, rename, rounds: [{ ...round('ready'), reviewer: 'r1' }], related: [{ sessionId: 'r1', label: 'Show its reviewer' }] })), actions.calls),
      ...wiring(agentTileMenu(tileInput({ ...galleryAgent('hibernated'), sessionId: 'a2', endedAt: AT }, { actions, board: boardSpies(actions.calls), rename })), actions.calls).filter((line) => /^(wake|run\/)/.test(line)),
      ...wiring(agentTileMenu(tileInput({ ...ended, sessionId: 'a3', reviewOf: 'a1' }, { actions, board: boardSpies(actions.calls), rename, review: round('ready') })), actions.calls).filter((line) => /^(open-review|arrange\/fold)/.test(line)),
    ]).toMatchInlineSnapshot(`
      [
        "go-to-question → openAgent(#a1)",
        "expand → expand("n1")",
        "pop-out → popOutAgent(#a1)",
        "run/interrupt → interruptAgent("a1")",
        "run/pause → pauseAgent("a1")",
        "run/stop → stopAgent("a1")",
        "settings/rename → rename()",
        "settings/schedule → scheduleAgent(#a1)",
        "settings/link-issue → linkIssue(#a1)",
        "settings/mute → setMuted("a1", true)",
        "settings/reasoning/default → setEffort("a1", null)",
        "settings/reasoning/low → setEffort("a1", "low")",
        "settings/reasoning/medium → setEffort("a1", "medium")",
        "settings/reasoning/high → setEffort("a1", "high")",
        "settings/reasoning/xhigh → setEffort("a1", "xhigh")",
        "settings/reasoning/max → setEffort("a1", "max")",
        "review/open-pr → openPullRequest(#a1, #?)",
        "review/open-review → openReview("a1")",
        "review/start-review → startReview(#a1)",
        "review/show-r1 → show("r1")",
        "review/run-gate → openGate(#a1, true)",
        "arrange/front → restack("front")",
        "arrange/forward → restack("forward")",
        "arrange/backward → restack("backward")",
        "arrange/back → restack("back")",
        "arrange/lead-pin → toggleLeadPin()",
        "arrange/connect → connect()",
        "ask → askClaude()",
        "copy/branch → copy("acme-18-waiting", "Branch name")",
        "copy/worktree → copy("/worktrees/gallery", "Worktree path")",
        "copy/session-id → copy("a1", "Session id")",
        "delete → deleteAgent("a1")",
        "wake → resumeAgent("a2")",
        "run/stop → stopAgent("a2")",
        "open-review → openReview("a1")",
        "arrange/fold → setFolded("n1", true)",
      ]
    `);
  });

  it("is wired in a shell's and an external session's menus", () => {
    const actions = spies<ShellMenuInput['actions'] & Parameters<typeof externalMenu>[1]>();
    const rename = () => void actions.calls.push(['rename', []]);
    expect([
      ...wiring(shellMenu({ nodeId: 'n1', shell: { id: 's1' } as Shell, clickOpens: 'window', rename, actions }), actions.calls),
      ...wiring(shellMenu({ nodeId: 'n1', shell: { id: 's1' } as Shell, clickOpens: 'expand', rename, actions }), actions.calls).slice(0, 1),
      ...wiring(externalMenu({ id: 'e1' } as ExternalSession, actions), actions.calls),
    ]).toMatchInlineSnapshot(`
      [
        "expand → expand("n1")",
        "pop-out → popOutShell(#s1)",
        "rename → rename()",
        "delete → deleteShell("s1")",
        "open-window → openShell(#s1)",
        "resume → resumeExternal(#e1)",
        "delete → dismissExternal("e1")",
      ]
    `);
  });

  it("is wired in a zone's ⋯ and tab menus", () => {
    const actions = spies<ZoneMenuInput['actions'] & Parameters<typeof zoneTabEntries>[2]>();
    const rename = () => void actions.calls.push(['rename', []]);
    const tab = (zone: Zone) => Object.values(zoneTabEntries(zone, undefined, actions)).flatMap((entry) => (entry === undefined ? [] : [entry]));
    const tracked = { ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'] };
    const userGroup = { ...group, id: 'g1', defaultRepo: '/code/web', userFolder: true };
    const cloning = { ...repoZone, id: 'c1', clone: {} as Zone['clone'] };
    expect([
      ...wiring(zoneMenu({ zone: tracked, folded: [], themeFill: 8, rename, actions }), actions.calls),
      ...wiring(zoneMenu({ zone: userGroup, folded: [], themeFill: 8, rename, actions }), actions.calls),
      ...wiring(tab(tracked), actions.calls),
      ...wiring(tab(userGroup), actions.calls),
      ...wiring(tab(cloning), actions.calls),
      ...wiring(tidyMenu(repoZone, undefined, actions), actions.calls),
    ]).toMatchInlineSnapshot(`
      [
        "crew/crew-library → crewLibrary(#z1)",
        "tidy → tidy(#z1)",
        "spacing/layout-free → setLayoutMode(#z1, "free")",
        "spacing/layout-lanes → setLayoutMode(#z1, "lanes")",
        "spacing/layout-shelves → setLayoutMode(#z1, "shelves")",
        "spacing/layout-clusters → setLayoutMode(#z1, "clusters")",
        "spacing/spacing-compact → setSpacing(#z1, "compact")",
        "spacing/spacing-normal → setSpacing(#z1, "normal")",
        "spacing/spacing-roomy → setSpacing(#z1, "roomy")",
        "fold → fold(#z1)",
        "rename → rename()",
        "colour → recolor(#z1, "picked")",
        "fill-opacity → setFill(#z1, 12)",
        "unbind → unbind(#z1)",
        "trust-folder → setTrustsFolder(#z1, true)",
        "board-mcp → setBoardMcp(#z1, false)",
        "orchestrate → setAgentsOrchestrate(#z1, true)",
        "gate-command → editGateCommand(#z1)",
        "role-templates → editRoleTemplates(#z1)",
        "delete → deleteZone(#z1)",
        "crew/crew-library → crewLibrary(#g1)",
        "tidy → tidy(#g1)",
        "spacing/layout-free → setLayoutMode(#g1, "free")",
        "spacing/layout-lanes → setLayoutMode(#g1, "lanes")",
        "spacing/layout-shelves → setLayoutMode(#g1, "shelves")",
        "spacing/layout-clusters → setLayoutMode(#g1, "clusters")",
        "spacing/spacing-compact → setSpacing(#g1, "compact")",
        "spacing/spacing-normal → setSpacing(#g1, "normal")",
        "spacing/spacing-roomy → setSpacing(#g1, "roomy")",
        "fold → fold(#g1)",
        "rename → rename()",
        "colour → recolor(#g1, "picked")",
        "fill-opacity → setFill(#g1, 12)",
        "default-repo → pickDefaultRepo(#g1)",
        "init-repo → initRepo(#g1)",
        "board-mcp → setBoardMcp(#g1, false)",
        "orchestrate → setAgentsOrchestrate(#g1, true)",
        "gate-command → editGateCommand(#g1)",
        "role-templates → editRoleTemplates(#g1)",
        "delete → deleteZone(#g1)",
        "tab-tracker → pickTracker(#z1)",
        "tab-add-issue → addIssue(#z1)",
        "tab-new-agent → newAgent(#z1)",
        "tab-new-shell → newShell(#z1)",
        "tab-default-repo → pickDefaultRepo(#g1)",
        "tab-tracker → pickTracker(#g1)",
        "tab-bind/repo → bind(#g1, "repo")",
        "tab-bind/project → bind(#g1, "project")",
        "tab-bind/tracker → pickTracker(#g1)",
        "tab-new-agent → newAgent(#g1)",
        "tab-new-shell → newShell(#g1)",
        "tab-cancel-clone → cancelClone(#c1)",
        "tab-tracker → pickTracker(#c1)",
        "tab-new-agent → newAgent(#c1)",
        "tab-new-shell → newShell(#c1)",
        "tab-tidy → tidy(#c1)",
        "tidy → tidy(#z1)",
        "layout-free → setLayoutMode(#z1, "free")",
        "layout-lanes → setLayoutMode(#z1, "lanes")",
        "layout-shelves → setLayoutMode(#z1, "shelves")",
        "layout-clusters → setLayoutMode(#z1, "clusters")",
        "spacing-compact → setSpacing(#z1, "compact")",
        "spacing-normal → setSpacing(#z1, "normal")",
        "spacing-roomy → setSpacing(#z1, "roomy")",
        "new-zone-spacing → openSettings()",
      ]
    `);
  });
});

function projectInput(zone: Zone, more: Partial<ProjectContextMenuInput> = {}): ProjectContextMenuInput {
  return { zone, noAgents: undefined, technical: false, newZones: undefined, themeFill: 8, rename: () => {}, newNote: () => {}, actions: spies(), ...more };
}

/** What each action of a menu does, by its row's own id: no submenu or path, and a tab chip's row as ⋯'s. */
function doings(entries: readonly ModelEntry[], calls: [string, unknown[]][]): Map<string, Set<string>> {
  const done = new Map<string, Set<string>>();
  for (const line of wiring(entries, calls)) {
    const [path, made] = line.split(' → ') as [string, string];
    const id = path.split('/').at(-1)!.replace(/^tab-/, '');
    done.set(id, (done.get(id) ?? new Set()).add(made));
  }
  return done;
}

/** Handlers that remember every call, renaming among them. */
function recording() {
  const actions = spies<ProjectContextMenuInput['actions']>();
  return { actions, rename: () => void actions.calls.push(['rename', []]) };
}

/** What today's zone tab and ⋯ do, every chip folded in, with the tab's Tidy ▾. */
function classicDoings(zone: Zone): Map<string, Set<string>> {
  const { actions, rename } = recording();
  const tab = zoneTabEntries(zone, undefined, actions);
  const order = ['cancel-clone', 'agent', 'shell', 'default-repo', 'bind', 'tracker', 'issue', 'tidy'] as const;
  const folded = order.flatMap((chip) => (tab[chip] === undefined ? [] : [tab[chip]]));
  return doings([...zoneMenu({ zone, folded, themeFill: 8, rename, actions }), ...(zone.clone === null ? tidyMenu(zone, undefined, actions) : [])], actions.calls);
}

/** What `menu` does for `zone`'s project, with handlers that remember every call. */
function projectDoings(zone: Zone, menu: (input: ProjectContextMenuInput) => ModelEntry[]): Map<string, Set<string>> {
  const { actions, rename } = recording();
  return doings(menu(projectInput(zone, { actions, rename })), actions.calls);
}

/** Today's actions `project` lacks: each as `id → what it does`, missing when no row of that id does the same. */
function lost(classic: Map<string, Set<string>>, project: Map<string, Set<string>>): string[] {
  return [...classic].flatMap(([id, made]) => [...made].filter((call) => !project.get(id)?.has(call)).map((call) => `${id} → ${call}`));
}

const projects: [string, Zone][] = [
  ['a repo', { ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'], gateCommand: 'pnpm check', trustsFolder: true }],
  ['a group with a default repo, outside git', { ...group, defaultRepo: '/code/web', userFolder: true, fillOpacity: 30 }],
  ['a cloning project', { ...repoZone, clone: {} as Zone['clone'] }],
];

describe("a folded zone's chip menu", () => {
  it('unfolds without waking, unfolds and wakes, renames and deletes', () => {
    const actions = spies<ZoneMenuInput['actions']>();
    const rename = vi.fn();
    const entries = chipMenu({ zone: { ...repoZone, folded: true }, rename, actions });
    expect(menuIds(entries)).toEqual(['unfold', 'unfold-wake', 'rename', 'delete']);
    for (const id of ['unfold', 'unfold-wake', 'rename', 'delete']) (row(entries, id) as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['unfold', [{ ...repoZone, folded: true }, false]],
      ['unfold', [{ ...repoZone, folded: true }, true]],
      ['deleteZone', [{ ...repoZone, folded: true }]],
    ]);
    expect(rename).toHaveBeenCalledOnce();
  });
});

describe('folding a zone from its menus', () => {
  const folded: Zone = { ...repoZone, folded: true };
  /** The two designs' ⋯ menus, and the right-click menu of the Simplified one, over the same zone. */
  const menus: [string, (zone: Zone, actions: ProjectContextMenuInput['actions']) => ModelEntry[]][] = [
    ['the Classic zone', (zone, actions) => zoneMenu(zoneInput(zone, { actions }))],
    ['the Simplified project', (zone, actions) => projectMenu(projectInput(zone, { actions }))],
    ['the Simplified right-click menu', (zone, actions) => (row(projectContextMenu({ ...projectInput(zone, { actions }), newNote: () => {} }), 'options') as { entries: ModelEntry[] }).entries],
  ];

  it.each(menus)('offers %s Fold to a chip, and nothing to unfold, while it is open', (_name, menu) => {
    const actions = spies<ProjectContextMenuInput['actions']>();
    const entries = menu(repoZone, actions);
    expect(row(entries, 'fold')).toMatchObject({ label: 'Fold to a chip' });
    expect(menuIds(entries)).not.toContain('unfold');
    (row(entries, 'fold') as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([['fold', [repoZone]]]);
  });

  it.each(menus)('offers %s no Fold while it clones', (_name, menu) => {
    const entries = menu({ ...repoZone, clone: {} as Zone['clone'] }, spies<ProjectContextMenuInput['actions']>());
    expect(menuIds(entries)).not.toContain('fold');
  });

  it.each(menus)('offers %s Unfold, which wakes no one, and Unfold and wake, once it is folded', (_name, menu) => {
    const actions = spies<ProjectContextMenuInput['actions']>();
    const entries = menu(folded, actions);
    expect(menuIds(entries)).not.toContain('fold');
    expect(row(entries, 'unfold')).toMatchObject({ label: 'Unfold', hint: expect.stringMatching(/stay paused/) });
    expect(row(entries, 'unfold-wake')).toMatchObject({ label: 'Unfold and wake its agents', hint: expect.stringMatching(/folding paused/) });
    (row(entries, 'unfold') as { onSelect(): void }).onSelect();
    (row(entries, 'unfold-wake') as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['unfold', [folded, false]],
      ['unfold', [folded, true]],
    ]);
  });
});

describe("a project's menus, under the Simplified design", () => {
  it.each(projects)("keep every control of today's zone tab and ⋯ for %s, doing the same, in ⋯ and in the right-click menu", (_name, zone) => {
    const classic = classicDoings(zone);
    expect(classic.size).toBeGreaterThan(0);
    expect(lost(classic, projectDoings(zone, projectMenu))).toEqual([]);
    expect(lost(classic, projectDoings(zone, projectContextMenu))).toEqual([]);
  });

  it("wires every row of a project's menus", () => {
    const { actions, rename } = recording();
    const newNote = () => void actions.calls.push(['newNote', []]);
    expect(
      projects.flatMap(([name, zone]) => [`— ${name}`, ...wiring(projectContextMenu(projectInput(zone, { actions, rename, newNote })), actions.calls)]),
    ).toMatchInlineSnapshot(`
      [
        "— a repo",
        "new-agent → newAgent(#z1)",
        "crew/crew-library → crewLibrary(#z1)",
        "new-shell → newShell(#z1)",
        "new-note → newNote()",
        "add-issue → addIssue(#z1)",
        "rename → rename()",
        "tidy → tidy(#z1)",
        "colour-menu/colour → recolor(#z1, "picked")",
        "options/new-agent → newAgent(#z1)",
        "options/crew/crew-library → crewLibrary(#z1)",
        "options/new-shell → newShell(#z1)",
        "options/rename → rename()",
        "options/colour → recolor(#z1, "picked")",
        "options/fill-opacity → setFill(#z1, 12)",
        "options/tidy → tidy(#z1)",
        "options/spacing/spacing-compact → setSpacing(#z1, "compact")",
        "options/spacing/spacing-normal → setSpacing(#z1, "normal")",
        "options/spacing/spacing-roomy → setSpacing(#z1, "roomy")",
        "options/spacing/new-zone-spacing → openSettings()",
        "options/layout/layout-free → setLayoutMode(#z1, "free")",
        "options/layout/layout-lanes → setLayoutMode(#z1, "lanes")",
        "options/layout/layout-shelves → setLayoutMode(#z1, "shelves")",
        "options/layout/layout-clusters → setLayoutMode(#z1, "clusters")",
        "options/fold → fold(#z1)",
        "options/issues/tracker → pickTracker(#z1)",
        "options/issues/add-issue → addIssue(#z1)",
        "options/folder/trust-folder → setTrustsFolder(#z1, false)",
        "options/folder/unbind → unbind(#z1)",
        "options/agents/board-mcp → setBoardMcp(#z1, false)",
        "options/agents/orchestrate → setAgentsOrchestrate(#z1, true)",
        "options/agents/gate-command → editGateCommand(#z1)",
        "options/agents/role-templates → editRoleTemplates(#z1)",
        "options/delete → deleteZone(#z1)",
        "delete → deleteZone(#z1)",
        "— a group with a default repo, outside git",
        "new-agent → newAgent(#z1)",
        "crew/crew-library → crewLibrary(#z1)",
        "new-shell → newShell(#z1)",
        "new-note → newNote()",
        "rename → rename()",
        "tidy → tidy(#z1)",
        "colour-menu/colour → recolor(#z1, "picked")",
        "options/new-agent → newAgent(#z1)",
        "options/crew/crew-library → crewLibrary(#z1)",
        "options/new-shell → newShell(#z1)",
        "options/rename → rename()",
        "options/colour → recolor(#z1, "picked")",
        "options/fill-opacity → setFill(#z1, 12)",
        "options/tidy → tidy(#z1)",
        "options/spacing/spacing-compact → setSpacing(#z1, "compact")",
        "options/spacing/spacing-normal → setSpacing(#z1, "normal")",
        "options/spacing/spacing-roomy → setSpacing(#z1, "roomy")",
        "options/spacing/new-zone-spacing → openSettings()",
        "options/layout/layout-free → setLayoutMode(#z1, "free")",
        "options/layout/layout-lanes → setLayoutMode(#z1, "lanes")",
        "options/layout/layout-shelves → setLayoutMode(#z1, "shelves")",
        "options/layout/layout-clusters → setLayoutMode(#z1, "clusters")",
        "options/fold → fold(#z1)",
        "options/issues/tracker → pickTracker(#z1)",
        "options/folder/repo → bind(#z1, "repo")",
        "options/folder/project → bind(#z1, "project")",
        "options/folder/tracker → pickTracker(#z1)",
        "options/folder/default-repo → pickDefaultRepo(#z1)",
        "options/folder/init-repo → initRepo(#z1)",
        "options/agents/board-mcp → setBoardMcp(#z1, false)",
        "options/agents/orchestrate → setAgentsOrchestrate(#z1, true)",
        "options/agents/gate-command → editGateCommand(#z1)",
        "options/agents/role-templates → editRoleTemplates(#z1)",
        "options/delete → deleteZone(#z1)",
        "delete → deleteZone(#z1)",
        "— a cloning project",
        "new-shell → newShell(#z1)",
        "new-note → newNote()",
        "options/new-agent → newAgent(#z1)",
        "options/new-shell → newShell(#z1)",
        "options/tidy → tidy(#z1)",
        "options/issues/tracker → pickTracker(#z1)",
        "options/folder/cancel-clone → cancelClone(#z1)",
      ]
    `);
  });

  it("lists a repo project's ⋯, its settings in submenus", () => {
    expect(menuIds(projectMenu(projectInput(projects[0]![1])))).toEqual([
      'new-agent',
      'crew',
      'crew/crew-library',
      'new-shell',
      'rename',
      'colour',
      'fill-opacity',
      'tidy',
      'spacing',
      'spacing/spacing-compact',
      'spacing/spacing-normal',
      'spacing/spacing-roomy',
      'spacing/new-zone-spacing',
      'layout',
      'layout/layout-free',
      'layout/layout-lanes',
      'layout/layout-shelves',
      'layout/layout-clusters',
      'fold',
      'issues',
      'issues/tracker',
      'issues/add-issue',
      'folder',
      'folder/trust-folder',
      'folder/unbind',
      'agents',
      'agents/board-mcp',
      'agents/orchestrate',
      'agents/gate-command',
      'agents/role-templates',
      'delete',
    ]);
  });

  it("gives a project with no folder the ways to get one, and a cloning one only Cancel clone", () => {
    const folder = (zone: Zone) => menuIds(projectMenu(projectInput(zone))).filter((id) => id.startsWith('folder/'));
    expect(folder(projects[1]![1])).toEqual(['folder/repo', 'folder/project', 'folder/tracker', 'folder/default-repo', 'folder/init-repo']);
    expect(folder(projects[2]![1])).toEqual(['folder/cancel-clone']);
  });

  it('lists the right-click menu: making things first, then the everyday actions, then ⋯ as Project options', () => {
    const ids = menuIds(projectContextMenu(projectInput(projects[0]![1]))).filter((id) => !id.startsWith('options/'));
    expect(ids).toEqual(['new-agent', 'crew', 'crew/crew-library', 'new-shell', 'new-note', 'add-issue', 'rename', 'tidy', 'colour-menu', 'colour-menu/colour', 'options', 'delete']);
  });

  it('marks its agent settings on or off, and flips them', () => {
    const actions = spies<ProjectContextMenuInput['actions']>();
    const entries = projectMenu(projectInput(projects[0]![1], { actions }));
    const agents = row(entries, 'agents') as { entries: ModelEntry[] };
    expect(row(agents.entries, 'board-mcp')).toMatchObject({ checked: true });
    expect(row(agents.entries, 'orchestrate')).toMatchObject({ checked: false });
    (row(agents.entries, 'board-mcp') as { onSelect(): void }).onSelect();
    (row(agents.entries, 'orchestrate') as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['setBoardMcp', [projects[0]![1], false]],
      ['setAgentsOrchestrate', [projects[0]![1], true]],
    ]);
  });

  it('names rows plainly, and technically with Show technical details', () => {
    const labels = (technical: boolean) => {
      const agents = row(projectMenu(projectInput(projects[0]![1], { technical })), 'agents') as { entries: ModelEntry[] };
      return agents.entries.flatMap((entry) => (entry !== 'separator' && 'label' in entry ? [entry.label] : []));
    };
    expect(labels(false)).toEqual(['Board tools for new agents', 'Let agents start and manage agents', 'Check before merging…', 'Role templates…']);
    expect(labels(true)).toEqual(['Board MCP for new agents', 'Let agents orchestrate', 'Gate command…', 'Role templates…']);
  });

  it("says why it can't start an agent, and Delete… is last and red", () => {
    const entries = projectContextMenu(projectInput(repoZone, { noAgents: 'Still cloning' }));
    expect(row(entries, 'new-agent')).toMatchObject({ disabled: true, hint: 'Still cloning' });
    expect(entries.at(-1)).toMatchObject({ id: 'delete', label: 'Delete project…', danger: true });
  });
});
