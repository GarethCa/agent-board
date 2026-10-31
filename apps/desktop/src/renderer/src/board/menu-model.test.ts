import { describe, expect, it } from 'vitest';
import { ZONE_COLORS, type Agent, type ExternalSession, type GateRun, type ReviewRound, type Shell, type Zone } from '@agent-board/daemon/protocol';
import { keyText } from '../keys/registry';
import { runGateShortcut } from '../session/window-keys';
import { agentMenu, bindEntries, externalMenu, menuIds, priorityEntries, shellMenu, tidyMenu, zoneMenu, zoneTabEntries, type AgentMenuInput, type ModelEntry, type ZoneMenuInput, type ShellMenuInput, type ZonePriorityActions } from './menu-model';
import { galleryAgent } from './TileGallery';

const AT = '2026-10-22T12:00:00.000Z';

/** Handlers that remember what was called, with what. */
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
    expect(menuIds(agentMenu(agentInput(running)))).toEqual(['expand', 'pop-out', 'pause', 'rename', 'schedule', 'link-issue', 'mute', 'start-review', 'run-gate', 'delete']);
  });

  it('offers to open its window when a click expands it, and the other way round', () => {
    expect(menuIds(agentMenu(agentInput(running, { clickOpens: 'expand' })))[0]).toBe('open-window');
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
  priority: 'normal',
  usageHold: null,
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
      'tidy',
      'spacing',
      'spacing/spacing-compact',
      'spacing/spacing-normal',
      'spacing/spacing-roomy',
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
    expect(menuIds(entries).slice(0, 2)).toEqual(['tab-new-agent', 'tidy']);
    expect(entries[1]).toBe('separator');
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
    const actions = spies<ZoneMenuInput['actions']>();
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

  it("offers a repo zone's tracker, new agent and shell, and priority, with Tidy left to ⋯", () => {
    expect(ids(repoZone)).toEqual(['tracker', 'agent', 'shell', 'priority']);
  });

  it("offers a group's binding and default repo, a tracker's issues, and a clone's Cancel and Tidy", () => {
    expect(ids({ ...group, defaultRepo: '/code/web' })).toEqual(['default-repo', 'tracker', 'bind', 'agent', 'shell', 'priority']);
    expect(ids({ ...repoZone, tracker: { provider: 'github', scope: 'acme/web' } as Zone['tracker'] })).toContain('issue');
    expect(ids({ ...repoZone, clone: {} as Zone['clone'] })).toEqual(['cancel-clone', 'tracker', 'agent', 'shell', 'priority', 'tidy']);
  });

  it("says why a zone can't start agents", () => {
    expect(zoneTabEntries(repoZone, 'Still cloning', spies()).agent).toMatchObject({ disabled: true, hint: 'Still cloning' });
  });
});

describe("a zone's tab menus", () => {
  it('lists Tidy ▾: Tidy now, its spacings, and the spacing for new zones', () => {
    expect(menuIds(tidyMenu(repoZone, undefined, spies()))).toEqual(['tidy', 'spacing-compact', 'spacing-normal', 'spacing-roomy', 'new-zone-spacing']);
    expect(row(tidyMenu(repoZone, 'roomy', spies()), 'new-zone-spacing')).toMatchObject({ detail: 'Roomy · Settings' });
  });

  it('lists its priorities, and Override while it is held', () => {
    expect(menuIds(priorityEntries(repoZone, spies()))).toEqual(['priority-high', 'priority-normal', 'priority-low']);
    expect(menuIds(priorityEntries({ ...repoZone, usageHold: { reason: 'over budget', since: AT } }, spies()))).toEqual(['priority-high', 'priority-normal', 'priority-low', 'override']);
  });

  it('sets its priority and lifts its hold through the handlers it was given', () => {
    const actions = spies<ZonePriorityActions>();
    const held = { ...repoZone, usageHold: { reason: 'over budget', since: AT } };
    const entries = priorityEntries(held, actions);
    for (const id of ['priority-high', 'override']) (row(entries, id) as { onSelect(): void }).onSelect();
    expect(actions.calls).toEqual([
      ['setPriority', [held, 'high']],
      ['releaseHold', [held]],
    ]);
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
  const order = ['cancel-clone', 'agent', 'shell', 'default-repo', 'bind', 'tracker', 'priority', 'issue', 'tidy'] as const;
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
          "id": "tab-tracker",
          "label": "Issues from acme/web…",
        },
        {
          "entries": [
            {
              "checked": false,
              "id": "priority-high",
              "label": "High",
            },
            {
              "checked": true,
              "id": "priority-normal",
              "label": "Normal",
            },
            {
              "checked": false,
              "id": "priority-low",
              "label": "Low",
            },
          ],
          "id": "tab-priority",
          "label": "Priority",
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
          "label": "Spacing",
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
        {
          "entries": [
            {
              "checked": false,
              "id": "priority-high",
              "label": "High",
            },
            {
              "checked": true,
              "id": "priority-normal",
              "label": "Normal",
            },
            {
              "checked": false,
              "id": "priority-low",
              "label": "Low",
            },
          ],
          "id": "tab-priority",
          "label": "Priority",
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
          "label": "Spacing",
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
          "entries": [
            {
              "checked": false,
              "id": "priority-high",
              "label": "High",
            },
            {
              "checked": true,
              "id": "priority-normal",
              "label": "Normal",
            },
            {
              "checked": false,
              "id": "priority-low",
              "label": "Low",
            },
          ],
          "id": "tab-priority",
          "label": "Priority",
        },
        {
          "id": "tab-tidy",
          "label": "Tidy",
        },
      ]
    `);
  });

  it("pins the tab's Tidy ▾, a held zone's priorities, and Bind…", () => {
    expect(fields(tidyMenu(repoZone, 'roomy', spies()))).toMatchInlineSnapshot(`
      [
        {
          "id": "tidy",
          "label": "Tidy now",
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
    expect(fields(priorityEntries({ ...repoZone, priority: 'high', usageHold: { reason: 'over budget', since: AT } }, spies()))).toMatchInlineSnapshot(`
      [
        {
          "checked": true,
          "id": "priority-high",
          "label": "High",
        },
        {
          "checked": false,
          "id": "priority-normal",
          "label": "Normal",
        },
        {
          "checked": false,
          "id": "priority-low",
          "label": "Low",
        },
        "separator",
        {
          "heading": "Held: over budget",
        },
        {
          "hint": "Lift the hold: its starts and hand-offs go on",
          "id": "override",
          "label": "Override",
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
        "start-review → startReview(#a5)",
        "run-gate → openGate(#a5, true)",
        "delete → deleteAgent("a5")",
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
        "tidy → tidy(#z1)",
        "spacing/spacing-compact → setSpacing(#z1, "compact")",
        "spacing/spacing-normal → setSpacing(#z1, "normal")",
        "spacing/spacing-roomy → setSpacing(#z1, "roomy")",
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
        "tidy → tidy(#g1)",
        "spacing/spacing-compact → setSpacing(#g1, "compact")",
        "spacing/spacing-normal → setSpacing(#g1, "normal")",
        "spacing/spacing-roomy → setSpacing(#g1, "roomy")",
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
        "tab-priority/priority-high → setPriority(#z1, "high")",
        "tab-priority/priority-normal → setPriority(#z1, "normal")",
        "tab-priority/priority-low → setPriority(#z1, "low")",
        "tab-default-repo → pickDefaultRepo(#g1)",
        "tab-tracker → pickTracker(#g1)",
        "tab-bind/repo → bind(#g1, "repo")",
        "tab-bind/project → bind(#g1, "project")",
        "tab-bind/tracker → pickTracker(#g1)",
        "tab-new-agent → newAgent(#g1)",
        "tab-new-shell → newShell(#g1)",
        "tab-priority/priority-high → setPriority(#g1, "high")",
        "tab-priority/priority-normal → setPriority(#g1, "normal")",
        "tab-priority/priority-low → setPriority(#g1, "low")",
        "tab-cancel-clone → cancelClone(#c1)",
        "tab-tracker → pickTracker(#c1)",
        "tab-new-agent → newAgent(#c1)",
        "tab-new-shell → newShell(#c1)",
        "tab-priority/priority-high → setPriority(#c1, "high")",
        "tab-priority/priority-normal → setPriority(#c1, "normal")",
        "tab-priority/priority-low → setPriority(#c1, "low")",
        "tab-tidy → tidy(#c1)",
        "tidy → tidy(#z1)",
        "spacing-compact → setSpacing(#z1, "compact")",
        "spacing-normal → setSpacing(#z1, "normal")",
        "spacing-roomy → setSpacing(#z1, "roomy")",
        "new-zone-spacing → openSettings()",
      ]
    `);
  });
});
