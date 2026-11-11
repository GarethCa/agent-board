// The menus of agents, shells and zones, as data: each row's label, icon, shortcut, enabled rule, danger flag and the
// handler it calls, with a stable id. Any menu of one of them (its tile's or tab's ⋯, a right-click, the menu bar) takes
// its rows from here, so a row reads and does the same wherever it shows. Pure, so it is unit-tested.
import {
  AlignStartVertical,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Brain,
  Check,
  CircleDot,
  Bell,
  BellOff,
  Clock,
  Coins,
  Copy,
  Ellipsis,
  Expand,
  FileCheck,
  FileSearch,
  FileText,
  FolderCheck,
  FolderGit2,
  FolderPlus,
  FoldVertical,
  GitBranch,
  GitPullRequest,
  Hash,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  LocateFixed,
  ListPlus,
  ListTodo,
  Maximize2,
  MessageCircleQuestion,
  Network,
  OctagonX,
  Palette,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Rows3,
  Settings2,
  ShieldCheck,
  Sparkles,
  Spline,
  SquareArrowOutUpRight,
  StickyNote,
  Trash2,
  UnfoldVertical,
  Unlink,
  X,
  Users,
  Zap,
  LibraryBig,
} from 'lucide-react';
import { CrewFaces } from '../crews/icons';
import { crewGroups } from '../crews/prefab-store';
import {
  ARRANGE_SPACINGS,
  continuesOnCredits,
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  ZONE_FILL_OPACITY,
  HARNESS_EFFORTS,
  ZONE_LAYOUT_MODES,
  type Agent,
  type Effort,
  type ArrangeSpacing,
  type ExternalSession,
  type GateRun,
  type ReviewRound,
  type Shell,
  type Zone,
  type ZoneBinding,
  type ZoneLayoutMode,
  waitsOnUser,
} from '@agent-board/daemon/protocol';
import { isClosed, SPACING_GAPS } from '@agent-board/daemon/board-layout';
import { startBlocked } from '@agent-board/daemon/review-doc';
import type { MenuAction, MenuHeading, SliderRow, Submenu, SwatchRow } from '../ui/Menu';
import { EFFORT_HINTS, EFFORT_LABELS } from './AgentSetup';
import { gated } from '../gate/gate-view';
import { runGateShortcut } from '../session/window-keys';
import { keyText } from '../keys/registry';
import { canRestart } from '../session/RestartAgent';
import type { ClickOpens } from './click-opens';
import { folderLabel } from './folders';
import { pauseControl } from './paused';
import type { Reorder } from './editing/arrange';
import { sessionControls, type ControlId } from '../session/controls';
import type { TileActions } from './tile';

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
  return clickOpens === 'expand'
    ? { id: 'open-window', label: 'Open window', icon: <Maximize2 />, onSelect: open }
    : { id: 'expand', label: 'Expand in place', icon: <Expand />, onSelect: expand };
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
  | 'setEffort'
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
    reasoningEntry(agent, actions),
    'separator',
    ...reviewEntries(input),
    ...gateEntries(agent, gate, actions),
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
}

/** Its Run gate row, for an agent with a worktree of its own: disabled while a run is under way. */
function gateEntries(agent: Agent, gate: GateRun | undefined, actions: Pick<AgentMenuActions, 'openGate'>): ModelEntry[] {
  if (!gated(agent)) return [];
  const running = gate?.status === 'running';
  return [
    {
      id: 'run-gate',
      label: 'Run gate',
      icon: <ShieldCheck />,
      shortcut: runGateShortcut(),
      disabled: running,
      hint: running ? 'It is running: its Gate tab shows it' : "Run its zone's gate command in its worktree",
      onSelect: () => actions.openGate(agent, true),
    },
  ];
}

/** A tile the agent's is linked to, to show: its implementer or reviewer, or the orchestrator that started it. */
export interface RelatedTile {
  sessionId: string;
  /** Its row's words, as "Show its reviewer" or "Show checkout-fix". */
  label: string;
}

/** What an agent tile's menu does to the tile on the board, rather than to the agent. */
export interface TileBoardActions {
  /** Opens Ask Claude about the tile. */
  askClaude(): void;
  /** Brings the tile forward or to the front, or sends it back. */
  restack(how: Reorder): void;
  /** Waits for a click on what to join the tile to; absent where it can't be joined. */
  connect?: () => void;
  /** For a lead tile in a shelved zone: whether it is pinned top-left, and how to free or pin it. */
  leadPin?: { pinned: boolean; toggle(): void };
  /** Puts the text on the clipboard, saying what it was. */
  copy(text: string, what: string): void;
  /** Selects the tile of the session and flies to it. */
  show(sessionId: string): void;
}

type AgentTileMenuActions = AgentMenuActions & Pick<TileActions, 'interruptAgent' | 'stopAgent' | 'openPullRequest'>;

/** What an agent tile's menu is drawn from: its agent menu's input, and what it does to the tile on the board. */
export interface AgentTileMenuInput extends AgentMenuInput {
  actions: AgentTileMenuActions;
  board: TileBoardActions;
  /** The tiles it is linked to, still on the board. */
  related: readonly RelatedTile[];
  /** For a reviewer, the round it writes. */
  review: ReviewRound | undefined;
}

/**
 * The one step that leads an agent tile's menu, when it has one: the place to answer its question, Wake while it is
 * paused, or a reviewer's review once its doc is in. Each opens where to act, and does nothing for the user there.
 */
function nextStep({ nodeId, agent, clickOpens, review, actions }: AgentTileMenuInput): ModelEntry[] {
  if (agent.endedAt === null && (agent.state === 'needs-permission' || agent.permissions.length > 0 || waitsOnUser(agent)))
    return [
      {
        id: 'go-to-question',
        label: 'Go to its question',
        icon: <MessageCircleQuestion />,
        hint: 'Opens it, to answer there',
        onSelect: () => (clickOpens === 'expand' ? actions.expand(nodeId) : actions.openAgent(agent)),
      },
    ];
  const pause = pauseControl(agent);
  if (pause?.action === 'wake') return [{ id: 'wake', label: 'Wake', icon: <Play />, hint: pause.hint, onSelect: () => void actions.resumeAgent(agent.sessionId) }];
  if (agent.reviewOf !== null && review?.status === 'ready')
    return [{ id: 'open-review', label: 'Open review', icon: <FileCheck />, hint: 'Its doc is in', onSelect: () => actions.openReview(agent.reviewOf!) }];
  return [];
}

/** Run ▸: interrupt or pause it, carry an ended one on, and, kept apart, stop its session. */
function runEntries(agent: Agent, actions: AgentTileMenuActions): ModelEntry[] {
  const controls = sessionControls({ agent, live: true });
  const control = (id: ControlId) => controls.find((each) => each.id === id);
  const interrupt = control('interrupt');
  const pause = control('pause');
  const stop = control('stop');
  const going: ModelEntry[] = [
    ...(agent.endedAt === null && interrupt !== undefined
      ? [{ id: 'interrupt', label: 'Interrupt', icon: <Zap />, disabled: !interrupt.enabled, hint: interrupt.hint, onSelect: () => actions.interruptAgent(agent.sessionId) }]
      : []),
    ...(pause === undefined ? [] : [{ id: 'pause', label: 'Pause', icon: <Pause />, disabled: !pause.enabled, hint: pause.hint, onSelect: () => void actions.pauseAgent(agent.sessionId) }]),
    ...(canRestart(agent) ? [{ id: 'restart', label: 'Restart agent', icon: <RotateCcw />, onSelect: () => actions.restartAgent(agent.sessionId) }] : []),
    ...(agent.state === 'stopped-by-restart' ? [{ id: 'resume', label: 'Resume agent', icon: <RotateCcw />, onSelect: () => void actions.resumeAgent(agent.sessionId) }] : []),
    ...(continuesOnCredits(agent) ? [{ id: 'continue-on-credits', label: 'Continue on credits', icon: <Coins />, onSelect: () => void actions.continueOnCredits(agent.sessionId) }] : []),
  ];
  const stopping: ModelEntry[] =
    stop?.enabled === true ? [{ id: 'stop', label: 'Stop session', icon: <OctagonX />, hint: stop.hint, onSelect: () => actions.stopAgent(agent.sessionId) }] : [];
  return [...going, ...(going.length > 0 && stopping.length > 0 ? ['separator' as const] : []), ...stopping];
}

/** Review & gate ▸: its own pull request, its reviews, the tiles it is linked to, and its gate. */
function reviewGateEntries(input: AgentTileMenuInput): ModelEntry[] {
  const { agent, gate, related, actions } = input;
  const [pr] = agent.pullRequests;
  const checks: ModelEntry[] = [
    ...(pr === undefined ? [] : [{ id: 'open-pr', label: `Open pull request #${pr.number}`, icon: <GitPullRequest />, hint: pr.title, onSelect: () => actions.openPullRequest(agent, pr) }]),
    ...reviewEntries(input),
    ...related.map((tile): ModelEntry => ({ id: `show-${tile.sessionId}`, label: tile.label, icon: <LocateFixed />, onSelect: () => input.board.show(tile.sessionId) })),
  ];
  const gates = gateEntries(agent, gate, actions);
  return [...checks, ...(checks.length > 0 && gates.length > 0 ? ['separator' as const] : []), ...gates];
}

/** Arrange ▸: the tile's z-order (its keys still work), Align, which takes two or more, and its place on the board. */
function arrangeEntries({ nodeId, agent, board, actions }: AgentTileMenuInput): ModelEntry[] {
  const place: ModelEntry[] = [
    ...(isClosed(agent) ? [{ id: 'fold', label: 'Fold to a chip', icon: <FoldVertical />, onSelect: () => actions.setFolded(nodeId, true) }] : []),
    ...(board.leadPin === undefined
      ? []
      : [
          board.leadPin.pinned
            ? { id: 'lead-pin', label: 'Free from top-left', icon: <PinOff />, hint: 'It goes on the shelves as a stack of its own', onSelect: board.leadPin.toggle }
            : { id: 'lead-pin', label: 'Pin top-left', icon: <Pin />, hint: "Back in the zone's head row, above the shelves", onSelect: board.leadPin.toggle },
        ]),
    ...(board.connect === undefined ? [] : [{ id: 'connect', label: 'Connect to…', icon: <Spline />, hint: 'Then click what to join it to', onSelect: board.connect }]),
  ];
  return [
    { id: 'front', label: 'Bring to front', icon: <ArrowUpToLine />, shortcut: keyText('edit.front'), onSelect: () => board.restack('front') },
    { id: 'forward', label: 'Bring forward', icon: <ArrowUp />, shortcut: keyText('edit.forward'), onSelect: () => board.restack('forward') },
    { id: 'backward', label: 'Send backward', icon: <ArrowDown />, shortcut: keyText('edit.backward'), onSelect: () => board.restack('backward') },
    { id: 'back', label: 'Send to back', icon: <ArrowDownToLine />, shortcut: keyText('edit.back'), onSelect: () => board.restack('back') },
    // As the selection's Align ▸, which a lone tile has nothing to line up with.
    { id: 'align', label: 'Align', icon: <AlignStartVertical />, disabled: true, hint: 'Select two or more to line them up', entries: [] },
    ...(place.length > 0 ? ['separator' as const, ...place] : []),
  ];
}

/** Copy ▸: its branch name, worktree path and session id. */
function copyEntries({ agent, board }: AgentTileMenuInput): ModelEntry[] {
  const copy = (id: string, label: string, text: string, what: string): ModelEntry => ({
    id,
    label,
    icon: <Copy />,
    ...(text === '' ? { disabled: true, hint: 'It has none' } : { detail: text }),
    onSelect: () => board.copy(text, what),
  });
  return [copy('branch', 'Branch name', agent.branch, 'Branch name'), copy('worktree', 'Worktree path', agent.worktree, 'Worktree path'), copy('session-id', 'Session id', agent.sessionId, 'Session id')];
}

/**
 * An agent tile's menu, from its ⋯ and a right-click alike: its next step first when it has one, how to open it, then
 * its rows in groups (Run, Settings, Review & gate, Arrange), Ask Claude, Copy and Delete. Ten rows at most, so it fits
 * beside a tile. No row answers, approves or nudges the agent: each does only what is pressed.
 */
export function agentTileMenu(input: AgentTileMenuInput): ModelEntry[] {
  const { nodeId, agent, clickOpens, rename, actions, board } = input;
  const run = runEntries(agent, actions);
  const review = reviewGateEntries(input);
  return [
    ...nextStep(input),
    otherOpen(clickOpens, () => actions.expand(nodeId), () => actions.openAgent(agent)),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutAgent(agent) },
    'separator',
    ...(run.length === 0 ? [] : [{ id: 'run', label: 'Run', icon: <Play />, entries: run }]),
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings2 />,
      entries: [
        { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: rename },
        { id: 'schedule', label: agent.schedule === null ? 'Schedule…' : 'Edit schedule…', icon: <Clock />, onSelect: () => actions.scheduleAgent(agent) },
        { id: 'link-issue', label: agent.issue === null ? 'Link issue…' : 'Change issue…', icon: <Hash />, onSelect: () => actions.linkIssue(agent) },
        {
          id: 'mute',
          label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
          icon: agent.muted ? <Bell /> : <BellOff />,
          onSelect: () => actions.setMuted(agent.sessionId, !agent.muted),
        },
        reasoningEntry(agent, actions),
      ],
    },
    ...(review.length === 0 ? [] : [{ id: 'review', label: 'Review & gate', icon: <ShieldCheck />, entries: review }]),
    { id: 'arrange', label: 'Arrange', icon: <Layers />, entries: arrangeEntries(input) },
    'separator',
    { id: 'ask', label: 'Ask Claude about it…', icon: <Sparkles />, shortcut: keyText('make.askClaude'), hint: 'Sends nothing until you press Ask', onSelect: board.askClaude },
    { id: 'copy', label: 'Copy', icon: <Copy />, entries: copyEntries(input) },
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, shortcut: keyText('tile.delete'), onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
}

/**
 * An agent's Reasoning ▸: Default (its harness's own) and the levels its harness takes, its own ticked, the outer ones
 * saying what they cost. A live Claude agent has a level typed at its prompt between turns; anything else, and Default
 * (no harness can be told it live), applies when the agent restarts, which the submenu says.
 */
function reasoningEntry(agent: Agent, actions: Pick<AgentMenuActions, 'setEffort'>): ModelEntry {
  const live = agent.endedAt === null;
  const typed = live && agent.harness === 'claude';
  const row = (id: string, label: string, effort: Effort | null, hint?: string): ModelEntry => ({
    id,
    label,
    icon: agent.effort === effort ? <Check /> : <span className="agent-setup-blank" aria-hidden />,
    ...(hint === undefined ? {} : { hint }),
    onSelect: () => actions.setEffort(agent.sessionId, effort),
  });
  return {
    id: 'reasoning',
    label: 'Reasoning',
    icon: <Brain />,
    detail: agent.effort === null ? 'Default' : EFFORT_LABELS[agent.effort],
    entries: [
      { heading: typed ? 'Typed at its prompt between turns' : 'Applies when the agent restarts' },
      row('default', 'Default', null, typed ? 'Applies when the agent restarts' : undefined),
      ...HARNESS_EFFORTS[agent.harness].map((effort) => row(effort, EFFORT_LABELS[effort], effort, EFFORT_HINTS[effort])),
    ],
  };
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
  /** Draws the zone's work as `mode` lays it out: free, on shelves, or in clusters. Moves no tile's saved place. */
  setLayoutMode(zone: Zone, mode: ZoneLayoutMode): void;
  /** Folds it to a chip: its agents that can pause are paused and its terminals let go. */
  fold(zone: Zone): void;
  /** Unfolds it. Its paused agents stay paused unless `wake` is asked for. */
  unfold(zone: Zone, wake: boolean): void;
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
  /** Opens the prompt box of a crew from the prefab named, in the zone. */
  startCrew(prefab: string, zone: Zone): void;
  /** Opens the app's crew library, one for every board, a crew from it starting in the zone. */
  crewLibrary(zone: Zone): void;
}

/** What a zone's menus do to it: the handlers its tab is given, but for renaming, which its menu starts in place. */
type ZoneMenuActions = Omit<ZoneBindingActions, 'rename'>;

/**
 * The rows that fold a zone to a chip while it isn't needed, or unfold it: Fold, or Unfold (its agents stay paused, as
 * nothing wakes an agent by itself) and Unfold and wake, which wakes the agents the fold paused and none paused before
 * it. The same in both designs' menus.
 */
function foldRows(zone: Zone, actions: Pick<ZoneMenuActions, 'fold' | 'unfold'>): ModelEntry[] {
  // While it clones it has nothing to fold, and its header has no Fold button either.
  if (zone.clone !== null) return [];
  if (!zone.folded) {
    return [
      {
        id: 'fold',
        label: 'Fold to a chip',
        icon: <FoldVertical />,
        hint: 'Pauses the agents that can pause and lets their terminals go, to free memory. The chip keeps a count and anything that needs you',
        onSelect: () => actions.fold(zone),
      },
    ];
  }
  return [
    { id: 'unfold', label: 'Unfold', icon: <UnfoldVertical />, hint: 'Its agents stay paused until you wake them', onSelect: () => actions.unfold(zone, false) },
    { id: 'unfold-wake', label: 'Unfold and wake its agents', icon: <UnfoldVertical />, hint: 'Wakes the agents that folding paused. One paused before the fold stays paused', onSelect: () => actions.unfold(zone, true) },
  ];
}

/**
 * The ⋯ and right-click menu of a folded zone's chip: unfold it (or unfold and wake), rename it, delete it. `simplified`
 * words the delete as the Simplified design's project does.
 */
export function chipMenu({ zone, rename, actions, simplified = false }: Pick<ZoneMenuInput, 'zone' | 'rename' | 'actions'> & { simplified?: boolean }): ModelEntry[] {
  return [
    ...foldRows(zone, actions),
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil />, onSelect: rename },
    {
      id: 'delete',
      label: simplified ? 'Delete project…' : 'Delete zone…',
      icon: <X />,
      danger: true,
      hint: simplified ? 'Its agents stay on the board where they are' : 'Its tiles stay on the board where they are',
      onSelect: () => actions.deleteZone(zone),
    },
  ];
}

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
 * A Tidy row's state in a zone on shelves or in clusters: disabled, saying why, since the zone lays itself out and a tidy
 * would move the places its tiles are not drawn at. Nothing for a free zone.
 */
export function tidyBlocked(zone: Pick<Zone, 'layoutMode'>): { disabled: true; hint: string } | Record<string, never> {
  if (zone.layoutMode === 'shelves') return { disabled: true, hint: 'Not on status shelves: it would move the tiles folded into stacks' };
  if (zone.layoutMode === 'clusters') return { disabled: true, hint: 'Not in clusters: the zone lays its tiles out itself' };
  return {};
}

/** Each zone layout's name and what it draws, as the zone's Layout menu offers them. */
const LAYOUT_MODE_LABELS: Record<ZoneLayoutMode, { label: string; hint: string }> = {
  free: { label: 'Free', hint: 'Each tile where you put it' },
  shelves: { label: 'Status shelves', hint: 'Shelves by status, a stack per ticket' },
  clusters: { label: 'Clusters', hint: "Each ticket's tiles together, what needs you first" },
};

function layoutModeEntries(zone: Zone, actions: Pick<ZoneMenuActions, 'setLayoutMode'>): ModelEntry[] {
  return ZONE_LAYOUT_MODES.map((mode) => ({
    id: `layout-${mode}`,
    label: LAYOUT_MODE_LABELS[mode].label,
    hint: LAYOUT_MODE_LABELS[mode].hint,
    checked: zone.layoutMode === mode,
    onSelect: () => actions.setLayoutMode(zone, mode),
  }));
}

/**
 * The tab's Tidy ▾ menu: Tidy now, the zone's layout and spacing, and where the spacing for new zones is set, named as it is
 * (`newZones`, read as the menu opens).
 */
export function tidyMenu(zone: Zone, newZones: ArrangeSpacing | undefined, actions: Pick<ZoneMenuActions, 'tidy' | 'setSpacing' | 'openSettings' | 'setLayoutMode'>): ModelEntry[] {
  return [
    { id: 'tidy', label: 'Tidy now', icon: <LayoutGrid />, ...tidyBlocked(zone), onSelect: () => actions.tidy(zone) },
    'separator',
    { heading: 'Layout' },
    ...layoutModeEntries(zone, actions),
    'separator',
    { heading: 'Spacing in this zone' },
    ...spacingEntries(zone, actions),
    'separator',
    { id: 'new-zone-spacing', label: 'Default for new zones…', icon: <Rows3 />, detail: newZones === undefined ? 'Settings' : `${SPACING_LABELS[newZones]} · Settings`, onSelect: actions.openSettings },
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
export type ZoneTabChip = 'default-repo' | 'cancel-clone' | 'tracker' | 'issue' | 'bind' | 'agent' | 'shell' | 'tidy' | 'fold';

/** The handlers a zone's tab chips call. */
export interface ZoneTabActions {
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
    // The zone's own ⋯ has Tidy already; while it clones, ⋯ holds only what folded.
    tidy: clone === null ? undefined : { id: 'tab-tidy', label: 'Tidy', icon: <LayoutGrid />, ...tidyBlocked(zone), onSelect: () => actions.tidy(zone) },
    // ⋯ has Fold to a chip already, and a zone still cloning has no Fold button.
    fold: undefined,
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
  // A crew is one more way to start something: under what starts an agent or a shell, where those folded onto this menu.
  const afterStarts = folded.findLastIndex((entry) => entry !== 'separator' && 'id' in entry && (entry.id === 'tab-new-agent' || entry.id === 'tab-new-shell')) + 1;
  return [
    ...folded.slice(0, afterStarts),
    crewRow(zone, actions, 'New crew'),
    ...folded.slice(afterStarts),
    'separator',
    { id: 'tidy', label: 'Tidy', icon: <LayoutGrid />, hint: 'Its tiles in rows, in reading order', ...tidyBlocked(zone), onSelect: () => actions.tidy(zone) },
    // One row for both, so ⋯ grows no taller for the layout.
    {
      id: 'spacing',
      label: 'Layout and spacing',
      icon: <Rows3 />,
      entries: [{ heading: 'Layout' }, ...layoutModeEntries(zone, actions), 'separator', { heading: 'Spacing' }, ...spacingEntries(zone, actions)],
    },
    ...foldRows(zone, actions),
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

/** What a project's menus do under the Simplified design: everything its zone's tab and ⋯ do, but rename. */
export type ProjectMenuActions = ZoneMenuActions & ZoneTabActions;

/** What a project's ⋯ menu is drawn from, under the Simplified design. */
export interface ProjectMenuInput {
  zone: Zone;
  /** Why no agent can start in it, if one can't. */
  noAgents: string | undefined;
  /** Whether rows use their technical names (Show technical details): "repo", "board MCP", "orchestrate". */
  technical: boolean;
  /** The spacing new projects take, named as it is (read as the menu opens). */
  newZones: ArrangeSpacing | undefined;
  /** The fill opacity the theme gives it while it has none of its own, in percent. */
  themeFill: number;
  /** Starts renaming it in place. */
  rename(): void;
  actions: ProjectMenuActions;
}

const newAgentRow = ({ zone, noAgents, actions }: ProjectMenuInput, label: string): ModelEntry => ({
  id: 'new-agent',
  label,
  icon: <Plus />,
  disabled: noAgents !== undefined,
  hint: noAgents,
  onSelect: () => actions.newAgent(zone),
});

/** A crew to start in the zone, from the library as last known, yours first; or the library itself. */
const crewRow = (zone: Zone, actions: Pick<ZoneMenuActions, 'startCrew' | 'crewLibrary'>, label: string): ModelEntry => ({
  id: 'crew',
  label,
  icon: <Users />,
  entries: [
    ...crewGroups().flatMap((group): ModelEntry[] => [
      ...group.map((prefab): ModelEntry => ({ id: `crew-${prefab.name}`, label: prefab.name, icon: <CrewFaces members={prefab.members} />, onSelect: () => actions.startCrew(prefab.name, zone) })),
      'separator',
    ]),
    { id: 'crew-library', label: 'Library…', icon: <LibraryBig />, onSelect: () => actions.crewLibrary(zone) },
  ],
});

const newShellRow = ({ zone, actions }: ProjectMenuInput, label: string): ModelEntry => ({
  id: 'new-shell',
  label,
  icon: <Plus />,
  onSelect: () => actions.newShell(zone),
});

const addIssueRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => ({ id: 'add-issue', label: 'Add issue…', icon: <ListPlus />, detail: zone.tracker?.scope, onSelect: () => actions.addIssue(zone) });

const tidyUpRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => ({ id: 'tidy', label: 'Tidy up', icon: <LayoutGrid />, hint: 'Its tiles in rows, in reading order', ...tidyBlocked(zone), onSelect: () => actions.tidy(zone) });

const colourRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => ({
  id: 'colour',
  label: 'Colour',
  swatches: ZONE_COLORS.map((color) => ({ name: ZONE_COLOR_NAMES[color] ?? color, value: color, pressed: zone.color === color })),
  onPick: (color: string) => actions.recolor(zone, color),
});

const deleteRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => ({
  id: 'delete',
  label: 'Delete project…',
  icon: <X />,
  danger: true,
  hint: 'Its agents stay on the board where they are',
  onSelect: () => actions.deleteZone(zone),
});

/** A project's Folder ›: its folder, trusting it and unbinding it; for a project with none, the ways to get one; or Cancel clone. */
function folderEntries({ zone, technical, actions }: ProjectMenuInput): ModelEntry[] {
  if (zone.clone !== null) return [{ id: 'cancel-clone', label: 'Cancel clone', icon: <X />, danger: true, onSelect: () => actions.cancelClone(zone) }];
  if (zone.repoRoot !== null) {
    return [
      { heading: zone.folder === '' ? zone.repoRoot : `${zone.repoRoot}/${zone.folder}` },
      {
        id: 'trust-folder',
        label: 'Trust this folder for new agents',
        icon: zone.trustsFolder ? <Check /> : <FolderCheck />,
        checked: zone.trustsFolder,
        hint: "Claude's trust prompt is answered for agents started in this folder",
        onSelect: () => actions.setTrustsFolder(zone, !zone.trustsFolder),
      },
      { id: 'unbind', label: technical ? 'Unbind from its repo' : 'Unbind from its folder', icon: <Unlink />, hint: 'Its agents keep their folders, and it keeps its issues', onSelect: () => actions.unbind(zone) },
    ];
  }
  return [
    { id: 'repo', label: 'Open a folder as a repo…', icon: <GitBranch />, onSelect: () => actions.bind(zone, 'repo') },
    { id: 'project', label: 'Open a folder as a project…', icon: <FolderPlus />, onSelect: () => actions.bind(zone, 'project') },
    { id: 'tracker', label: 'Link to a Linear team or GitHub repo…', icon: <ListTodo />, onSelect: () => actions.pickTracker(zone) },
    {
      id: 'default-repo',
      label: technical ? 'Default repo for new agents…' : 'Default folder for new agents…',
      icon: <FolderGit2 />,
      detail: zone.defaultRepo === null ? undefined : folderLabel(zone.defaultRepo, undefined),
      hint: 'New agents here start in it without asking',
      onSelect: () => actions.pickDefaultRepo(zone),
    },
    ...(zone.userFolder
      ? [{ id: 'init-repo', label: 'Make it a git repo', icon: <GitBranch />, hint: 'New agents then get folders of their own', onSelect: () => actions.initRepo(zone) }]
      : []),
  ];
}

/** A project's Agents in this project ›: what the agents started in it get and may do. */
function agentSettingEntries({ zone, technical, actions }: ProjectMenuInput): ModelEntry[] {
  return [
    {
      id: 'board-mcp',
      label: technical ? 'Board MCP for new agents' : 'Board tools for new agents',
      icon: zone.boardMcp ? <Check /> : <Plug />,
      checked: zone.boardMcp,
      hint: 'Agents started here can see and use the board',
      onSelect: () => actions.setBoardMcp(zone, !zone.boardMcp),
    },
    {
      id: 'orchestrate',
      label: technical ? 'Let agents orchestrate' : 'Let agents start and manage agents',
      icon: zone.agentsOrchestrate ? <Check /> : <Network />,
      checked: zone.agentsOrchestrate,
      hint: zone.agentsOrchestrate ? 'Turning it off stops every agent here doing so now' : 'Agents you start here may start, message and close agents in it',
      onSelect: () => actions.setAgentsOrchestrate(zone, !zone.agentsOrchestrate),
    },
    {
      id: 'gate-command',
      label: technical ? 'Gate command…' : 'Check before merging…',
      icon: <ShieldCheck />,
      detail: technical ? (zone.gateCommand ?? undefined) : undefined,
      hint: "What checks an agent's work before it is merged",
      onSelect: () => actions.editGateCommand(zone),
    },
    { id: 'role-templates', label: 'Role templates…', icon: <FileText />, hint: 'What agents started here in a role begin with', onSelect: () => actions.editRoleTemplates(zone) },
  ];
}

/**
 * A project's ⋯ menu under the Simplified design: every control of its zone's tab and ⋯, its settings in submenus.
 * While it clones, only what a cloning zone offers.
 */
export function projectMenu(input: ProjectMenuInput): ModelEntry[] {
  const { zone, newZones, themeFill, rename, actions } = input;
  const issues: ModelEntry = {
    id: 'issues',
    label: 'Issues',
    icon: <CircleDot />,
    entries: [
      { id: 'tracker', label: 'Where issues come from…', icon: <CircleDot />, detail: zone.tracker?.scope, onSelect: () => actions.pickTracker(zone) },
      ...(zone.tracker === null ? [] : [addIssueRow(input)]),
    ],
  };
  const folder: ModelEntry = { id: 'folder', label: 'Folder', icon: <FolderGit2 />, entries: folderEntries(input) };
  if (zone.clone !== null) return [newAgentRow(input, 'New agent'), newShellRow(input, 'New terminal'), 'separator', tidyUpRow(input), issues, folder];
  return [
    newAgentRow(input, 'New agent'),
    crewRow(zone, input.actions, 'New crew'),
    newShellRow(input, 'New terminal'),
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil />, onSelect: rename },
    colourRow(input),
    {
      id: 'fill-opacity',
      label: 'Fill',
      value: zone.fillOpacity ?? themeFill,
      ...ZONE_FILL_OPACITY,
      format: (value: number) => `${value}%`,
      onChange: (value: number) => actions.previewFill(zone, value),
      onCommit: (value: number) => actions.setFill(zone, value),
      onCancel: () => actions.cancelFill(zone),
    },
    'separator',
    tidyUpRow(input),
    {
      id: 'spacing',
      label: 'Spacing',
      icon: <Rows3 />,
      entries: [
        ...spacingEntries(zone, actions),
        'separator',
        { id: 'new-zone-spacing', label: 'Default for new projects…', icon: <Rows3 />, detail: newZones === undefined ? 'Settings' : `${SPACING_LABELS[newZones]} · Settings`, onSelect: actions.openSettings },
      ],
    },
    { id: 'layout', label: 'Layout', icon: <LayoutDashboard />, entries: layoutModeEntries(zone, actions) },
    ...foldRows(zone, actions),
    issues,
    folder,
    { id: 'agents', label: 'Agents in this project', icon: <Network />, entries: agentSettingEntries(input) },
    'separator',
    deleteRow(input),
  ];
}

/** What a project's right-click menu adds to its ⋯: a note where it was asked for. */
export interface ProjectContextMenuInput extends ProjectMenuInput {
  newNote(): void;
}

/**
 * A project's right-click menu under the Simplified design: making things in it and the everyday actions first, then its
 * ⋯ as Project options ›, so every row of ⋯ is one level down from here too.
 */
export function projectContextMenu(input: ProjectContextMenuInput): ModelEntry[] {
  const { zone, rename, newNote } = input;
  const note: ModelEntry = { id: 'new-note', label: 'New note here', icon: <StickyNote />, onSelect: newNote };
  const options: ModelEntry = { id: 'options', label: 'Project options', icon: <Ellipsis />, entries: projectMenu(input) };
  if (zone.clone !== null) return [newShellRow(input, 'New terminal here'), note, 'separator', options];
  return [
    newAgentRow(input, 'New agent here'),
    crewRow(zone, input.actions, 'New crew here'),
    newShellRow(input, 'New terminal here'),
    note,
    ...(zone.tracker === null ? [] : [addIssueRow(input)]),
    'separator',
    { id: 'rename', label: 'Rename', icon: <Pencil />, onSelect: rename },
    tidyUpRow(input),
    { id: 'colour-menu', label: 'Colour', icon: <Palette />, entries: [colourRow(input)] },
    options,
    'separator',
    deleteRow(input),
  ];
}
