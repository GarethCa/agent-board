// The menus of agents, shells and zones, as data: each row's label, icon, shortcut, enabled rule, danger flag and the
// handler it calls, with a stable id. Any menu of one of them (its tile's or tab's ⋯, a right-click, the menu bar) takes
// its rows from here, so a row reads and does the same wherever it shows. Pure, so it is unit-tested.
import {
  CircleDot,
  Bell,
  BellOff,
  Clock,
  Coins,
  Expand,
  FileCheck,
  FileSearch,
  FileText,
  FolderCheck,
  FolderGit2,
  FolderPlus,
  FoldVertical,
  Gauge,
  GitBranch,
  Hash,
  LayoutGrid,
  Link2,
  ListPlus,
  ListTodo,
  Maximize2,
  Network,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Rows3,
  ShieldCheck,
  SquareArrowOutUpRight,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import {
  ARRANGE_SPACINGS,
  continuesOnCredits,
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  ZONE_FILL_OPACITY,
  ZONE_PRIORITIES,
  type Agent,
  type ArrangeSpacing,
  type ExternalSession,
  type GateRun,
  type ReviewRound,
  type Shell,
  type Zone,
  type ZoneBinding,
  type ZonePriority,
} from '@agent-board/daemon/protocol';
import { isClosed, SPACING_GAPS } from '@agent-board/daemon/board-layout';
import { startBlocked } from '@agent-board/daemon/review-doc';
import type { MenuAction, MenuHeading, SliderRow, Submenu, SwatchRow } from '../ui/Menu';
import { gated } from '../gate/gate-view';
import { runGateShortcut } from '../session/window-keys';
import { keyText } from '../keys/registry';
import { canRestart } from '../session/RestartAgent';
import type { ClickOpens } from './click-opens';
import { folderLabel } from './folders';
import { pauseControl } from './paused';
import type { TileActions } from './tile';
import { PRIORITY_LABELS, zoneHold, zonePriority } from './zone-priority';

/** A row of a model menu, with the id the menu bar and tests know it by. Headings and separators carry none. */
export type ModelEntry =
  | (MenuAction & { id: string })
  | (Omit<Submenu, 'entries'> & { id: string; entries: ModelEntry[] })
  | (SwatchRow & { id: string })
  | (SliderRow & { id: string })
  | MenuHeading
  | 'separator';

/** The ids of a menu's rows in order, each submenu's rows after it as `submenu/row`. */
export function menuIds(entries: readonly ModelEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry === 'separator' || 'heading' in entry) return [];
    return 'entries' in entry ? [entry.id, ...menuIds(entry.entries).map((id) => `${entry.id}/${id}`)] : [entry.id];
  });
}

/** The ⋯ menu's way to do, once, what a click on the tile doesn't: expand it in place, or open its window. */
function otherOpen(clickOpens: ClickOpens, expand: () => void, open: () => void): ModelEntry {
  return clickOpens === 'window'
    ? { id: 'expand', label: 'Expand in place', icon: <Expand />, onSelect: expand }
    : { id: 'open-window', label: 'Open window', icon: <Maximize2 />, onSelect: open };
}

type AgentMenuActions = Pick<
  TileActions,
  | 'expand'
  | 'openAgent'
  | 'popOutAgent'
  | 'setFolded'
  | 'restartAgent'
  | 'resumeAgent'
  | 'continueOnCredits'
  | 'pauseAgent'
  | 'scheduleAgent'
  | 'linkIssue'
  | 'setMuted'
  | 'openReview'
  | 'startReview'
  | 'openGate'
  | 'deleteAgent'
>;

/** What an agent's menu is drawn from: the agent, its tile, what a click on the tile opens, and its gate and reviews. */
export interface AgentMenuInput {
  nodeId: string;
  agent: Agent;
  clickOpens: ClickOpens;
  /** Its latest gate run, if it has one. */
  gate: GateRun | undefined;
  /** Its review rounds as the implementer, first to last. */
  rounds: readonly ReviewRound[];
  /** Starts renaming it in place. */
  rename(): void;
  actions: AgentMenuActions;
}

/** An agent's rows. A reviewer opens the review it is writing; an implementer starts its next round, or opens the last. */
function reviewEntries({ agent, rounds, actions }: AgentMenuInput): ModelEntry[] {
  if (agent.reviewOf !== null) return [{ id: 'open-review', label: 'Open review', icon: <FileCheck />, onSelect: () => actions.openReview(agent.reviewOf!) }];
  const latestRound = rounds.at(-1);
  const notStarted = startBlocked(agent, rounds);
  return [
    ...(latestRound === undefined ? [] : [{ id: 'open-review', label: 'Open review', icon: <FileCheck />, onSelect: () => actions.openReview(agent.sessionId) }]),
    {
      id: 'start-review',
      label: latestRound === undefined ? 'Review its work' : `Start review round ${latestRound.round + 1}`,
      icon: <FileSearch />,
      disabled: notStarted !== undefined,
      hint: notStarted,
      onSelect: () => actions.startReview(agent),
    },
  ];
}

/** An agent's menu: how to open it, its run (restart, resume, credits, pause), its settings, its reviews and gate, and Delete. */
export function agentMenu(input: AgentMenuInput): ModelEntry[] {
  const { nodeId, agent, clickOpens, gate, rename, actions } = input;
  const pause = pauseControl(agent);
  return [
    otherOpen(clickOpens, () => actions.expand(nodeId), () => actions.openAgent(agent)),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutAgent(agent) },
    ...(isClosed(agent) ? [{ id: 'fold', label: 'Fold to a chip', icon: <FoldVertical />, onSelect: () => actions.setFolded(nodeId, true) }] : []),
    ...(canRestart(agent) ? [{ id: 'restart', label: 'Restart agent', icon: <RotateCcw />, onSelect: () => actions.restartAgent(agent.sessionId) }] : []),
    ...(agent.state === 'stopped-by-restart' ? [{ id: 'resume', label: 'Resume agent', icon: <RotateCcw />, onSelect: () => void actions.resumeAgent(agent.sessionId) }] : []),
    ...(continuesOnCredits(agent) ? [{ id: 'continue-on-credits', label: 'Continue on credits', icon: <Coins />, onSelect: () => void actions.continueOnCredits(agent.sessionId) }] : []),
    ...(pause === undefined
      ? []
      : [
          pause.action === 'wake'
            ? { id: 'wake', label: 'Wake', icon: <Play />, hint: pause.hint, onSelect: () => void actions.resumeAgent(agent.sessionId) }
            : { id: 'pause', label: 'Pause', icon: <Pause />, disabled: !pause.enabled, hint: pause.hint, onSelect: () => void actions.pauseAgent(agent.sessionId) },
        ]),
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: rename },
    { id: 'schedule', label: agent.schedule === null ? 'Schedule…' : 'Edit schedule…', icon: <Clock />, onSelect: () => actions.scheduleAgent(agent) },
    { id: 'link-issue', label: agent.issue === null ? 'Link issue…' : 'Change issue…', icon: <Hash />, onSelect: () => actions.linkIssue(agent) },
    {
      id: 'mute',
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <Bell /> : <BellOff />,
      onSelect: () => actions.setMuted(agent.sessionId, !agent.muted),
    },
    'separator',
    ...reviewEntries(input),
    ...(gated(agent)
      ? [
          {
            id: 'run-gate',
            label: 'Run gate',
            icon: <ShieldCheck />,
            shortcut: runGateShortcut(),
            disabled: gate?.status === 'running',
            hint: gate?.status === 'running' ? 'It is running: its Gate tab shows it' : "Run its zone's gate command in its worktree",
            onSelect: () => actions.openGate(agent, true),
          },
        ]
      : []),
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
}

/** What a shell's menu is drawn from. */
export interface ShellMenuInput {
  nodeId: string;
  shell: Shell;
  clickOpens: ClickOpens;
  rename(): void;
  actions: Pick<TileActions, 'expand' | 'openShell' | 'popOutShell' | 'deleteShell'>;
}

/** A shell's menu: how to open it, Rename and Delete. */
export function shellMenu({ nodeId, shell, clickOpens, rename, actions }: ShellMenuInput): ModelEntry[] {
  return [
    otherOpen(clickOpens, () => actions.expand(nodeId), () => actions.openShell(shell)),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutShell(shell) },
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: rename },
    'separator',
    { id: 'delete', label: 'Delete shell', icon: <Trash2 />, danger: true, onSelect: () => actions.deleteShell(shell.id) },
  ];
}

/** A session started outside the app: resume it here, or take it off the board. */
export function externalMenu(session: ExternalSession, actions: Pick<TileActions, 'resumeExternal' | 'dismissExternal'>): ModelEntry[] {
  return [
    { id: 'resume', label: 'Resume in agent-board…', icon: <Play />, onSelect: () => actions.resumeExternal(session) },
    'separator',
    { id: 'delete', label: 'Remove from board', icon: <Trash2 />, danger: true, onSelect: () => actions.dismissExternal(session.id) },
  ];
}

/** Each spacing's name in a menu. */
export const SPACING_LABELS: Record<ArrangeSpacing, string> = { compact: 'Compact', normal: 'Normal', roomy: 'Roomy' };

/**
 * What a zone's tab can do to the zone: to its binding, unbind it back into a group or set a group's default
 * repo; Tidy it; rename or recolour it, and delete it; turn the board MCP server off or on
 * for its agents.
 */
export interface ZoneBindingActions {
  unbind(zone: Zone): void;
  /** Makes a group's folder of the user's a git repo, with no commit, and binds the zone to it. */
  initRepo(zone: Zone): void;
  /** Asks for a group's default repo, to set or clear it. */
  pickDefaultRepo(zone: Zone): void;
  /** Lays its tiles out in rows, in reading order, and fits its height to them. */
  tidy(zone: Zone): void;
  /** Keeps `spacing` as the zone's, for its Tidy and its orchestrators' arrange, and tidies it at once. */
  setSpacing(zone: Zone, spacing: ArrangeSpacing): void;
  /** Opens Settings, where the spacing new zones take is. */
  openSettings(): void;
  /** Renames it; rejects if the daemon refuses. */
  rename(zone: Zone, name: string): Promise<unknown>;
  recolor(zone: Zone, color: string): void;
  /** Shows a fill opacity (a percent) on the zone as the slider is dragged, without saving it. */
  previewFill(zone: Zone, fillOpacity: number): void;
  /** Saves the fill opacity a drag ended on, as one step to undo, back to what the zone had before the drag. */
  setFill(zone: Zone, fillOpacity: number): void;
  /** Takes back a preview that is not to be saved: the zone is drawn as it was before the drag. */
  cancelFill(zone: Zone): void;
  /** Deletes a zone of any kind (after asking), leaving its tiles loose on the board where they are, and its notes and cards. */
  deleteZone(zone: Zone): void;
  /** Whether Claude's trust screen is answered for the agents started in its folder (`Zone.trustsFolder`). */
  setTrustsFolder(zone: Zone, on: boolean): void;
  /** Whether agents started in it get the board MCP server (ADR-0010). */
  setBoardMcp(zone: Zone, on: boolean): void;
  /** Lets the agents the user starts in the zone orchestrate there, or stops every agent in it orchestrating. */
  setAgentsOrchestrate(zone: Zone, on: boolean): void;
  /** Asks for the zone's gate command. */
  editGateCommand(zone: Zone): void;
  /** Opens the zone's role templates. */
  editRoleTemplates(zone: Zone): void;
}

/** What a zone's menus do to it: the handlers its tab is given, but for renaming, which its menu starts in place. */
type ZoneMenuActions = Omit<ZoneBindingActions, 'rename'>;

/** A zone's spacings to pick from, its own picked, each with its tile and lane gaps. */
function spacingEntries(zone: Zone, actions: Pick<ZoneMenuActions, 'setSpacing'>): ModelEntry[] {
  return ARRANGE_SPACINGS.map((spacing) => ({
    id: `spacing-${spacing}`,
    label: SPACING_LABELS[spacing],
    checked: zone.spacing === spacing,
    detail: `${SPACING_GAPS[spacing].tile} · ${SPACING_GAPS[spacing].lane}`,
    onSelect: () => actions.setSpacing(zone, spacing),
  }));
}

/**
 * The tab's Tidy ▾ menu: Tidy now, the zone's spacing, and where the spacing for new zones is set, named as it is
 * (`newZones`, read as the menu opens).
 */
export function tidyMenu(zone: Zone, newZones: ArrangeSpacing | undefined, actions: Pick<ZoneMenuActions, 'tidy' | 'setSpacing' | 'openSettings'>): ModelEntry[] {
  return [
    { id: 'tidy', label: 'Tidy now', icon: <LayoutGrid />, onSelect: () => actions.tidy(zone) },
    'separator',
    { heading: 'Spacing in this zone' },
    ...spacingEntries(zone, actions),
    'separator',
    { id: 'new-zone-spacing', label: 'Default for new zones…', icon: <Rows3 />, detail: newZones === undefined ? 'Settings' : `${SPACING_LABELS[newZones]} · Settings`, onSelect: actions.openSettings },
  ];
}

/** What a zone's priority menu does: pick its priority, or lift its hold for usage. */
export interface ZonePriorityActions {
  setPriority(zone: Zone, priority: ZonePriority): void;
  releaseHold(zone: Zone): void;
}

/** The zone's priorities to pick from, its own checked, and while it is held for usage, why, with Override. */
export function priorityEntries(zone: Zone, actions: ZonePriorityActions): ModelEntry[] {
  const hold = zoneHold(zone);
  return [
    ...ZONE_PRIORITIES.map((priority) => ({ id: `priority-${priority}`, label: PRIORITY_LABELS[priority], checked: zonePriority(zone) === priority, onSelect: () => actions.setPriority(zone, priority) })),
    ...(hold === null
      ? []
      : [
          'separator' as const,
          { heading: `Held: ${hold.reason}` },
          { id: 'override', label: 'Override', hint: 'Lift the hold: its starts and hand-offs go on', onSelect: () => actions.releaseHold(zone) },
        ]),
  ];
}

/** A group's ways to be bound: to a repo, to a new project, or to a tracker. */
export function bindEntries(zone: Zone, actions: { bind(zone: Zone, as: ZoneBinding): void; pickTracker(zone: Zone): void }): ModelEntry[] {
  return [
    { id: 'repo', label: 'Open as repo…', icon: <GitBranch />, onSelect: () => actions.bind(zone, 'repo') },
    { id: 'project', label: 'Open as project…', icon: <FolderPlus />, onSelect: () => actions.bind(zone, 'project') },
    { id: 'tracker', label: 'Bind to a Linear team or GitHub repo…', icon: <ListTodo />, onSelect: () => actions.pickTracker(zone) },
  ];
}

/** A chip on a zone's tab that can fold into its ⋯ menu. */
export type ZoneTabChip = 'default-repo' | 'cancel-clone' | 'tracker' | 'issue' | 'bind' | 'agent' | 'shell' | 'tidy' | 'priority';

/** The handlers a zone's tab chips call. */
export interface ZoneTabActions extends ZonePriorityActions {
  newAgent(zone: Zone): void;
  newShell(zone: Zone): void;
  pickTracker(zone: Zone): void;
  bind(zone: Zone, as: ZoneBinding): void;
  cancelClone(zone: Zone): void;
  addIssue(zone: Zone): void;
  pickDefaultRepo(zone: Zone): void;
  tidy(zone: Zone): void;
}

/**
 * What ⋯ offers in place of each chip on the zone's tab once it folds: undefined for a chip the tab doesn't show, or
 * whose row ⋯ has already. Each row's id is its chip's with `tab-` before it, so none is mistaken for a row of the
 * zone's own ⋯. `noAgents` is why it can't start agents, if it can't. The tab draws a chip under the same rule.
 */
export function zoneTabEntries(zone: Zone, noAgents: string | undefined, actions: ZoneTabActions): Record<ZoneTabChip, ModelEntry | undefined> {
  const { clone } = zone;
  return {
    'default-repo':
      zone.defaultRepo === null
        ? undefined
        : {
            id: 'tab-default-repo',
            label: folderLabel(zone.defaultRepo, undefined),
            icon: <GitBranch />,
            hint: 'The default repo: new agents here start in it',
            onSelect: () => actions.pickDefaultRepo(zone),
          },
    'cancel-clone': clone === null ? undefined : { id: 'tab-cancel-clone', label: 'Cancel clone', icon: <X />, danger: true, onSelect: () => actions.cancelClone(zone) },
    tracker: {
      id: 'tab-tracker',
      label: zone.tracker === null ? 'Pick where issues come from…' : `Issues from ${zone.tracker.scope}…`,
      icon: <CircleDot />,
      onSelect: () => actions.pickTracker(zone),
    },
    issue: zone.tracker === null ? undefined : { id: 'tab-add-issue', label: 'Add issue…', icon: <ListPlus />, onSelect: () => actions.addIssue(zone) },
    bind: zone.repoRoot === null && clone === null ? { id: 'tab-bind', label: 'Bind…', icon: <Link2 />, entries: bindEntries(zone, actions) } : undefined,
    agent: { id: 'tab-new-agent', label: 'New agent', icon: <Plus />, disabled: noAgents !== undefined, hint: noAgents, onSelect: () => actions.newAgent(zone) },
    shell: { id: 'tab-new-shell', label: 'New shell', icon: <Plus />, onSelect: () => actions.newShell(zone) },
    priority: { id: 'tab-priority', label: 'Priority', icon: <Gauge />, entries: priorityEntries(zone, actions) },
    // The zone's own ⋯ has Tidy already; while it clones, ⋯ holds only what folded.
    tidy: clone === null ? undefined : { id: 'tab-tidy', label: 'Tidy', icon: <LayoutGrid />, onSelect: () => actions.tidy(zone) },
  };
}

/** What a zone's ⋯ menu is drawn from: its folded chips' rows, the theme's fill when it has none of its own, and rename. */
export interface ZoneMenuInput {
  zone: Zone;
  /** The rows of the chips folded off its tab, the most needed first. */
  folded: readonly ModelEntry[];
  /** The fill opacity the theme gives it while it has none of its own, in percent. */
  themeFill: number;
  /** Starts renaming it in place. */
  rename(): void;
  actions: ZoneMenuActions;
}

/**
 * A zone's ⋯ menu: its folded chips, then Tidy, spacing, rename, colour, fill, its binding, its agents' settings, and
 * Delete. While it clones, it holds only what folded.
 */
export function zoneMenu({ zone, folded, themeFill, rename, actions }: ZoneMenuInput): ModelEntry[] {
  if (zone.clone !== null) return [...folded];
  const unbound = zone.repoRoot === null;
  return [
    ...(folded.length > 0 ? [...folded, 'separator' as const] : []),
    { id: 'tidy', label: 'Tidy', icon: <LayoutGrid />, hint: 'Its tiles in rows, in reading order', onSelect: () => actions.tidy(zone) },
    { id: 'spacing', label: 'Spacing', icon: <Rows3 />, entries: spacingEntries(zone, actions) },
    { id: 'rename', label: 'Rename', icon: <Pencil />, onSelect: rename },
    {
      id: 'colour',
      label: 'Colour',
      swatches: ZONE_COLORS.map((color) => ({ name: ZONE_COLOR_NAMES[color] ?? color, value: color, pressed: zone.color === color })),
      onPick: (color: string) => actions.recolor(zone, color),
    },
    {
      id: 'fill-opacity',
      label: 'Fill opacity',
      value: zone.fillOpacity ?? themeFill,
      ...ZONE_FILL_OPACITY,
      format: (value: number) => `${value}%`,
      onChange: (value: number) => actions.previewFill(zone, value),
      onCommit: (value: number) => actions.setFill(zone, value),
      onCancel: () => actions.cancelFill(zone),
    },
    unbound
      ? {
          id: 'default-repo',
          label: zone.defaultRepo === null ? 'Set a default repo…' : 'Change the default repo…',
          icon: <FolderGit2 />,
          hint: 'New agents here start in it without asking',
          onSelect: () => actions.pickDefaultRepo(zone),
        }
      : { id: 'unbind', label: 'Unbind', icon: <Unlink />, hint: 'Its agents keep their repos, and it keeps its issues', onSelect: () => actions.unbind(zone) },
    ...(zone.userFolder
      ? [
          {
            id: 'init-repo',
            label: 'Make it a git repo',
            icon: <GitBranch />,
            hint: 'git init, with no commit: new agents then get worktrees of their own',
            onSelect: () => actions.initRepo(zone),
          },
        ]
      : []),
    ...(unbound
      ? []
      : [
          {
            id: 'trust-folder',
            label: zone.trustsFolder ? "Stop trusting this zone's folder" : "Trust this zone's folder for new agents",
            icon: <FolderCheck />,
            hint: zone.trustsFolder
              ? "New agents show Claude's trust prompt again, for you to answer"
              : "Claude's trust prompt is answered for agents started in this folder and its worktrees",
            onSelect: () => actions.setTrustsFolder(zone, !zone.trustsFolder),
          },
        ]),
    {
      id: 'board-mcp',
      label: zone.boardMcp ? 'Turn off board MCP' : 'Turn on board MCP',
      icon: <Plug />,
      hint: zone.boardMcp ? 'Agents started here stop getting the agent-board MCP server; the CLI stays' : 'Agents started here get the agent-board MCP server again',
      onSelect: () => actions.setBoardMcp(zone, !zone.boardMcp),
    },
    {
      id: 'orchestrate',
      label: zone.agentsOrchestrate ? 'Stop agents orchestrating' : 'Let agents orchestrate',
      icon: <Network />,
      hint: zone.agentsOrchestrate ? 'Stops every agent here orchestrating now' : 'Agents you start here may start, message and close agents in this zone',
      onSelect: () => actions.setAgentsOrchestrate(zone, !zone.agentsOrchestrate),
    },
    {
      id: 'gate-command',
      label: zone.gateCommand === null ? 'Set a gate command…' : 'Change the gate command…',
      icon: <ShieldCheck />,
      hint: zone.gateCommand ?? "What checks an agent's work before it is merged, run when you ask",
      onSelect: () => actions.editGateCommand(zone),
    },
    {
      id: 'role-templates',
      label: 'Role templates…',
      icon: <FileText />,
      hint: 'What agents started here in a role begin with',
      onSelect: () => actions.editRoleTemplates(zone),
    },
    'separator',
    {
      id: 'delete',
      label: 'Delete zone…',
      icon: <X />,
      danger: true,
      hint: 'Its tiles stay on the board where they are',
      onSelect: () => actions.deleteZone(zone),
    },
  ];
}
