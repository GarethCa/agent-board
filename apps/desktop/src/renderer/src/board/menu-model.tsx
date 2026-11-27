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
  CheckCheck,
  CircleDot,
  Bell,
  BellOff,
  Clock,
  Coins,
  Copy,
  Ellipsis,
  Expand,
  Eye,
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
  Broom,
  Undo2,
  Link2,
  LocateFixed,
  ListPlus,
  ListTodo,
  Maximize2,
  MessageCircleQuestion,
  Network,
  OctagonX,
  Columns2,
  RotateCcw,
  Palette,
  Pause,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  Rows3,
  Settings2,
  TimerOff,
  UserRound,
  LayoutTemplate,
  ShieldCheck,
  Sparkles,
  Spline,
  SquareArrowOutUpRight,
  StickyNote,
  Trash2,
  UnfoldVertical,
  Unlink,
  X,
  Ticket,
  Users,
  Zap,
  LibraryBig,
  SquareKanban,
  SendHorizontal,
  AppWindow,
} from 'lucide-react';
import { CrewFaces } from '../crews/icons';
import { currentPrefabs, prefabGroupHeading, prefabGroups } from '../crews/prefab-store';
import {
  AGENT_ROLES,
  ARRANGE_SPACINGS,
  isOrchestratorRole,
  ORCHESTRATOR_ROLE,
  continuesOnCredits,
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  ZONE_FILL_OPACITY,
  HARNESS_EFFORTS,
  ZONE_LAYOUT_CHOICES,
  zoneLayoutChoiceOf,
  ARRANGE_ITEM_KINDS,
  ARRANGE_PLACEMENTS,
  placementsOf,
  type ArrangeItemKind,
  type ArrangePlacement,
  type Agent,
  type AgentState,
  type Effort,
  type ArrangeSpacing,
  type ExternalSession,
  type GateRun,
  type LibraryPrefab,
  type ReviewRound,
  type Shell,
  type Zone,
  type ZoneBinding,
  type NeedsYouShows,
  type ZoneLayoutChoice,
  waitsForYou,
} from '@agent-board/daemon/protocol';
import { isClosed, SPACING_GAPS } from '@agent-board/daemon/board-layout';
import { startBlocked } from '@agent-board/daemon/review-doc';
import type { MenuAction, MenuHeading, SliderRow, Submenu, SwatchRow } from '../ui/Menu';
import { EFFORT_HINTS, EFFORT_LABELS, ROLE_LABELS, roleText } from './AgentSetup';
import { gated } from '../gate/gate-view';
import { runGateShortcut } from '../session/window-keys';
import { keyText } from '../keys/registry';
import { openAgentTile, type ClickOpens } from './click-opens';
import { checksLabel } from './tile-footer';
import { folderLabel } from './folders';
import { asleep, pauseControl, restartsInPlace, wakeAct, wakeLabel } from './paused';
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

/**
 * An agent's first open row: under the pop-up setting, Open, which pops it up as a click on its tile does (its pop-up
 * holds Expand and Pop out); under the others, the way a click on the tile doesn't.
 */
function agentOpen({ nodeId, agent, clickOpens, actions }: { nodeId: string; agent: Agent; clickOpens: ClickOpens; actions: Pick<TileActions, 'expand' | 'openAgent' | 'popUp'> }): ModelEntry {
  if (clickOpens === 'popup') return { id: 'open', label: 'Open', icon: <AppWindow />, onSelect: () => actions.popUp(agent) };
  return otherOpen(clickOpens, () => actions.expand(nodeId), () => actions.openAgent(agent));
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
  | 'popUp'
  | 'popOutAgent'
  | 'setFolded'
  | 'wakeAgent'
  | 'turnClockOff'
  | 'resumeAgent'
  | 'continueOnCredits'
  | 'pauseAgent'
  | 'scheduleAgent'
  | 'linkIssue'
  | 'setMuted'
  | 'setEffort'
  | 'setRole'
  | 'restartWith'
  | 'openReview'
  | 'startReview'
  | 'openGate'
  | 'saveAsPrefab'
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

/**
 * Wake for the agent, by what it does (`wakeAct`): Wake for one asleep, done or exited, Wake now for one its clock wakes;
 * none for one at work, or a reviewer whose round ended. Wake fresh, when there is one, goes under it.
 */
function wakeEntries(agent: Agent, actions: Pick<AgentMenuActions, 'wakeAgent'>): ModelEntry[] {
  const act = wakeAct(agent);
  if (act === undefined) return [];
  const { label, hint } = wakeLabel(act);
  return [{ id: act === 'run-now' ? 'wake-now' : 'wake', label, icon: <Play />, hint, onSelect: () => void actions.wakeAgent(agent) }];
}

/** Its clock's rows: Schedule… while it has none, else Edit its clock… and, while the clock is on, Turn its clock off. */
function clockEntries(agent: Agent, actions: Pick<AgentMenuActions, 'scheduleAgent' | 'turnClockOff'>): ModelEntry[] {
  if (agent.schedule === null) return [{ id: 'schedule', label: 'Schedule…', icon: <Clock />, onSelect: () => actions.scheduleAgent(agent) }];
  return [
    { id: 'schedule', label: 'Edit its clock…', icon: <Clock />, onSelect: () => actions.scheduleAgent(agent) },
    ...(agent.schedule.enabled ? [{ id: 'clock-off', label: 'Turn its clock off', icon: <TimerOff />, hint: 'It keeps the clock; turn it on again from Edit its clock…', onSelect: () => actions.turnClockOff(agent) }] : []),
  ];
}

/** An agent's menu: how to open it, its run (restart, credits, pause or wake), its settings, its reviews and gate, and Delete. */
export function agentMenu(input: AgentMenuInput): ModelEntry[] {
  const { nodeId, agent, gate, rename, actions } = input;
  const pause = pauseControl(agent);
  return [
    agentOpen(input),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutAgent(agent) },
    ...(isClosed(agent) ? [{ id: 'fold', label: 'Fold to a chip', icon: <FoldVertical />, onSelect: () => actions.setFolded(nodeId, true) }] : []),
    ...(wakeAct(agent) === 'restart' ? wakeEntries(agent, actions) : []),
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
    ...(wakeAct(agent) === 'run-now' ? wakeEntries(agent, actions) : []),
    ...clockEntries(agent, actions),
    { id: 'link-issue', label: agent.issue === null ? 'Link issue…' : 'Change issue…', icon: <Hash />, onSelect: () => actions.linkIssue(agent) },
    {
      id: 'mute',
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <Bell /> : <BellOff />,
      onSelect: () => actions.setMuted(agent.sessionId, !agent.muted),
    },
    reasoningEntry(agent, actions),
    roleEntry(agent, actions),
    ...(restartsInPlace(agent)
      ? [{ id: 'restart-with', label: 'Restart with…', icon: <RotateCcw />, hint: 'Env vars it starts with; carries on its conversation', onSelect: () => actions.restartWith(agent) }]
      : []),
    'separator',
    ...reviewEntries(input),
    ...gateEntries(agent, gate, actions),
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
}

type PopUpAgentMenuActions = AgentMenuActions & Pick<TileActions, 'interruptAgent' | 'stopAgent' | 'restartAgent'>;

/** What an agent's menu in its pop-up is drawn from: its agent menu's input, and how the pop-up splits beside it. */
export interface PopUpAgentMenuInput extends AgentMenuInput {
  actions: PopUpAgentMenuActions;
  /**
   * The agents it can be split beside, each opening the pop-up's split with that agent on the right; none where it
   * can't be split.
   */
  openBeside?: readonly BesideChoice[] | undefined;
  /** Opens this agent beside the one shown, on another agent's tab; undefined where it can't. */
  openBesideThis?: (() => void) | undefined;
  /** Ends the split, on the tab of one side of it; undefined outside a split. */
  closeSide?: (() => void) | undefined;
}

/** An agent Open beside… offers, by name. */
export interface BesideChoice {
  id: string;
  label: string;
  onSelect(): void;
}

/** The rows of an agent's menu kept apart in its pop-up, as the run of it and its session. */
const POP_UP_RUN = ['pause', 'wake', 'continue-on-credits', 'run-gate', 'open-review', 'pop-out', 'fold'];

/**
 * An agent's menu in its pop-up, on its tab's ⋯ (or a right-click on the tab) and on a lone agent's header ⋯: its name,
 * then what it runs (Pause, Run gate, Open beside…, Open review, Pop out, Fold to a chip), its session (Interrupt, Rename,
 * Restart agent, Restart with…, Stop session), the rest of its menu, and Delete agent last. Open stays out: the pop-up is it.
 */
export function popUpAgentMenu(input: PopUpAgentMenuInput): ModelEntry[] {
  const { agent, actions, openBeside = [], openBesideThis, closeSide, rename } = input;
  const rows = agentMenu(input).filter((entry): entry is ModelEntry & { id: string } => entry !== 'separator' && 'id' in entry);
  const byId = (id: string) => rows.filter((entry) => entry.id === id);
  const controls = sessionControls({ agent, live: true });
  const interrupt = controls.find((each) => each.id === 'interrupt');
  const stop = controls.find((each) => each.id === 'stop');
  const run: ModelEntry[] = [
    ...byId('wake'),
    ...byId('pause'),
    ...byId('continue-on-credits'),
    ...byId('run-gate'),
    ...(closeSide !== undefined
      ? [{ id: 'close-side', label: 'Close this side', icon: <Columns2 />, hint: 'ends the split', onSelect: closeSide }]
      : openBesideThis !== undefined
        ? [{ id: 'open-beside', label: 'Open beside', icon: <Columns2 />, hint: 'splits the pop-up, this agent on the right', onSelect: openBesideThis }]
        : openBeside.length > 0
        ? [{ id: 'open-beside', label: 'Open beside…', icon: <Columns2 />, detail: 'split', entries: openBeside.map((each) => ({ id: `beside-${each.id}`, label: each.label, onSelect: each.onSelect })) }]
        : []),
    ...byId('open-review'),
    ...byId('pop-out'),
    ...byId('fold'),
  ];
  const session: ModelEntry[] = [
    ...(agent.endedAt === null && interrupt !== undefined
      ? [{ id: 'interrupt', label: 'Interrupt', icon: <Zap />, disabled: !interrupt.enabled, hint: interrupt.hint, onSelect: () => actions.interruptAgent(agent.sessionId) }]
      : []),
    { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: rename },
    ...(agent.endedAt === null && restartsInPlace(agent)
      ? [{ id: 'restart', label: 'Restart agent', icon: <RotateCcw />, hint: 'Stops it and starts it again, carrying on its conversation', onSelect: () => actions.restartAgent(agent.sessionId) }]
      : []),
    ...byId('restart-with'),
    ...(stop?.enabled === true ? [{ id: 'stop', label: 'Stop session', icon: <OctagonX />, hint: stop.hint, onSelect: () => actions.stopAgent(agent.sessionId) }] : []),
  ];
  const placed = new Set([...POP_UP_RUN, 'open', 'open-window', 'expand', 'rename', 'restart-with', 'delete']);
  const rest = rows.filter((entry) => !placed.has(entry.id));
  return [{ heading: agent.name }, ...run, 'separator', ...session, ...(rest.length > 0 ? ['separator' as const, ...rest] : []), 'separator', ...byId('delete')];
}

/**
 * Its pull requests as rows, the ones it made and then the ones it pushed to, each with its state and checks, opening
 * it in a PR tab: what the tile's PR chips say, for a menu (the pop-up's ⋯).
 */
export function pullRequestEntries(agent: Agent, actions: Pick<TileActions, 'openPullRequest'>): ModelEntry[] {
  const row = (pr: Agent['pullRequests'][number], pushed: boolean): ModelEntry => ({
    id: `pr-${pr.number}`,
    label: `${pushed ? 'Pushed to pull request' : 'Pull request'} #${pr.number}`,
    icon: <GitPullRequest />,
    hint: `${pr.state}, ${checksLabel(pr)}`,
    onSelect: () => actions.openPullRequest(agent, pr),
  });
  return [...agent.pullRequests.map((pr) => row(pr, false)), ...agent.pushedPullRequests.map((pr) => row(pr, true))];
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
  /** For a tile placed by hand in a zone with a layout rule: puts it back under the rule. */
  backUnderRule?: () => void;
  /** For an ended agent in a Spine zone: folds its finished ticket into the zone's Done line. */
  moveToDone?: () => void;
  /** Puts the text on the clipboard, saying what it was. */
  copy(text: string, what: string): void;
  /** Selects the tile of the session and flies to it. */
  show(sessionId: string): void;
}

type AgentTileMenuActions = AgentMenuActions & Pick<TileActions, 'interruptAgent' | 'stopAgent' | 'openPullRequest' | 'setPinnedExpanded'>;

/** What an agent tile's menu is drawn from: its agent menu's input, and what it does to the tile on the board. */
export interface AgentTileMenuInput extends AgentMenuInput {
  actions: AgentTileMenuActions;
  board: TileBoardActions;
  /** The tiles it is linked to, still on the board. */
  related: readonly RelatedTile[];
  /** For a reviewer, the round it writes. */
  review: ReviewRound | undefined;
  /** What the needs-you inbox lists, so the menu says Needs you of the agents its tile does. */
  shows: NeedsYouShows;
}

/** Whether a live agent waits on the user, by the rule its tile and the needs-you inbox use. */
const needsYou = ({ agent, shows }: Pick<AgentTileMenuInput, 'agent' | 'shows'>): boolean => agent.endedAt === null && waitsForYou(agent, shows);

/** The rows of `entries`, at its top level, whose id is `id`. */
const rowsWithId = (entries: readonly ModelEntry[], id: string): ModelEntry[] => entries.filter((entry) => entry !== 'separator' && !('heading' in entry) && entry.id === id);

/**
 * The one step that leads an agent tile's menu, when it has one: the place to answer its question, Wake while it is
 * paused, or a reviewer's review once its doc is in. Each opens where to act, and does nothing for the user there.
 */
function nextStep(input: AgentTileMenuInput): ModelEntry[] {
  const { nodeId, agent, clickOpens, review, actions } = input;
  if (needsYou(input))
    return [
      {
        id: 'go-to-question',
        label: 'Go to its question',
        icon: <MessageCircleQuestion />,
        hint: 'Opens it, to answer there',
        onSelect: () => openAgentTile(clickOpens, actions, nodeId, agent),
      },
    ];
  const wake = wakeEntries(agent, actions);
  // One its clock wakes has its clock's rows under Wake now, in place of Settings' own.
  if (wakeAct(agent) === 'run-now') return [...wake, ...clockEntries(agent, actions)];
  if (wake.length > 0) return wake;
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

/** Pin expanded, or Unpin: pinned, it stays open where it is, at its size. A closed agent has none to pin. */
function pinExpandedEntry(agent: Agent, actions: AgentTileMenuActions): ModelEntry[] {
  if (agent.pinnedExpanded) {
    return [{ id: 'pin-expanded', label: 'Unpin', icon: <PinOff />, hint: 'Then it can be collapsed, moved and resized', onSelect: () => actions.setPinnedExpanded(agent.sessionId, false) }];
  }
  if (isClosed(agent)) return [];
  return [{ id: 'pin-expanded', label: 'Pin expanded', icon: <Pin />, hint: 'It stays open where it is, at its size', onSelect: () => actions.setPinnedExpanded(agent.sessionId, true) }];
}

/** Arrange ▸: the tile's z-order (its keys still work), Align, which takes two or more, and its place on the board. */
function arrangeEntries({ nodeId, agent, board, actions }: AgentTileMenuInput): ModelEntry[] {
  const place: ModelEntry[] = [
    ...pinExpandedEntry(agent, actions),
    ...(isClosed(agent) ? [{ id: 'fold', label: 'Fold to a chip', icon: <FoldVertical />, onSelect: () => actions.setFolded(nodeId, true) }] : []),
    ...(board.leadPin === undefined
      ? []
      : [
          board.leadPin.pinned
            ? { id: 'lead-pin', label: 'Free from top-left', icon: <PinOff />, hint: 'It goes on the shelves as a stack of its own', onSelect: board.leadPin.toggle }
            : { id: 'lead-pin', label: 'Pin top-left', icon: <Pin />, hint: "Back in the zone's head row, above the shelves", onSelect: board.leadPin.toggle },
        ]),
    ...(board.backUnderRule === undefined ? [] : [{ id: 'follow-rule', label: 'Put back under the rule', icon: <Rows3 />, hint: "The zone's rule lays it out again", onSelect: board.backUnderRule }]),
    ...(board.moveToDone === undefined ? [] : [{ id: 'move-to-done', label: 'Move to Done', icon: <CheckCheck />, hint: "Folds its finished ticket into the zone's Done line", onSelect: board.moveToDone }]),
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

/** Settings ▸: rename it, its schedule, its issue, its notifications, its reasoning and its role. */
function settingsEntries(agent: Agent, rename: () => void, actions: AgentTileMenuActions): ModelEntry[] {
  return [
    { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: rename },
    // One its clock wakes has them at the top, under Wake now.
    ...(wakeAct(agent) === 'run-now' ? [] : clockEntries(agent, actions)),
    { id: 'link-issue', label: agent.issue === null ? 'Link issue…' : 'Change issue…', icon: <Hash />, onSelect: () => actions.linkIssue(agent) },
    {
      id: 'mute',
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <Bell /> : <BellOff />,
      onSelect: () => actions.setMuted(agent.sessionId, !agent.muted),
    },
    reasoningEntry(agent, actions),
    roleEntry(agent, actions),
  ];
}

/** Copy ▸: its branch name, worktree path and session id; then Save as prefab…, after Copy as in the right-click menu. */
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

/** Save as prefab…: the agent as a crew of one to start again, without its chat, ticket or branch. */
function savePrefabEntry({ agent, actions }: AgentTileMenuInput): ModelEntry {
  return { id: 'save-prefab', label: 'Save as prefab…', icon: <Users />, hint: 'Keeps its role, AI and model, not its chat', onSelect: () => actions.saveAsPrefab(agent) };
}

/**
 * An agent tile's menu, from its ⋯ and a right-click alike: its next step first when it has one, how to open it, then
 * its rows in groups (Run, Settings, Review & gate, Arrange), Ask Claude, Copy and Delete. Ten rows at most, so it fits
 * beside a tile. No row answers, approves or nudges the agent: each does only what is pressed.
 */
export function agentTileMenu(input: AgentTileMenuInput): ModelEntry[] {
  const { agent, rename, actions, board } = input;
  const run = runEntries(agent, actions);
  const review = reviewGateEntries(input);
  return [
    ...nextStep(input),
    agentOpen(input),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutAgent(agent) },
    'separator',
    ...(run.length === 0 ? [] : [{ id: 'run', label: 'Run', icon: <Play />, entries: run }]),
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings2 />,
      entries: settingsEntries(agent, rename, actions),
    },
    ...(review.length === 0 ? [] : [{ id: 'review', label: 'Review & gate', icon: <ShieldCheck />, entries: review }]),
    { id: 'arrange', label: 'Arrange', icon: <Layers />, entries: arrangeEntries(input) },
    'separator',
    { id: 'ask', label: 'Ask Claude about it…', icon: <Sparkles />, shortcut: keyText('make.askClaude'), hint: 'Sends nothing until you press Ask', onSelect: board.askClaude },
    { id: 'copy', label: 'Copy', icon: <Copy />, entries: [...copyEntries(input), 'separator', savePrefabEntry(input)] },
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, shortcut: keyText('tile.delete'), onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
}

/** What an agent tile's menu is shaped by under Classic: the six states, and Failed and Stopped, which lead with their own. */
type TileMenuState = 'thinking' | 'needs-you' | 'waiting' | 'idle' | 'done' | 'paused' | 'failed';

const THINKING_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'starting', 'handing-off', 'on-command']);

/**
 * What an agent that waits on something other than you waits on: the hint that names it, what shows it (absent, the
 * agent itself opens), and the id of the body row that does the same, which the menu then leaves out.
 */
interface WaitsOn {
  hint: string;
  show?: () => void;
  replaces?: string;
}

/** What the agent waits on, the first that holds; undefined when it waits on nothing. */
function waitsOn({ agent, rounds, related, board, actions }: AgentTileMenuInput): WaitsOn | undefined {
  if (agent.state === 'rate-limited') return { hint: 'Its usage limit' };
  if (agent.state === 'scheduled') return { hint: 'Its next scheduled run', show: () => actions.scheduleAgent(agent), replaces: 'schedule' };
  const latest = rounds.at(-1);
  const reviewer = latest?.status === 'reviewing' ? related.find((tile) => tile.sessionId === latest.reviewer) : undefined;
  if (reviewer !== undefined) return { hint: 'Its review', show: () => board.show(reviewer.sessionId), replaces: `show-${reviewer.sessionId}` };
  const checking = agent.pullRequests.find((pr) => pr.state === 'open' && pr.checks === 'pending');
  if (checking !== undefined) return { hint: `PR #${checking.number}'s checks`, show: () => actions.openPullRequest(agent, checking) };
  const category = agent.workCategory;
  if (category === null || (category.category !== 'waiting-on-others' && category.category !== 'in-review')) return undefined;
  const on = category.waitingOn;
  return { hint: on === null ? (category.label ?? 'Others') : on.ref === null ? on.who : `${on.who} · ${on.ref}` };
}

/** Which of its states an agent tile's menu is shaped by. */
function tileMenuState(input: AgentTileMenuInput): TileMenuState {
  const { agent } = input;
  // Stopped by a restart reads as paused: it is frosted, and Wake carries it on.
  if (asleep(agent)) return 'paused';
  if (agent.endedAt !== null) return agent.state === 'failed' ? 'failed' : 'done';
  if (needsYou(input)) return 'needs-you';
  if (THINKING_STATES.has(agent.state)) return 'thinking';
  if (agent.state === 'failed') return 'failed';
  if (agent.workFinishedAt !== null) return 'done';
  return waitsOn(input) === undefined ? 'idle' : 'waiting';
}

/** The mock's words for a row brought up to the top block, while it is enabled: a disabled one keeps its reason. */
const TOP_HINTS: Record<string, string> = {
  interrupt: 'Stops this turn; its session stays',
  pause: 'Frees its memory; Wake starts it where it left off',
  wake: 'Starts its session where it left off',
  'open-review': 'Its review doc is in',
};

function withTopHint(entry: ModelEntry): ModelEntry {
  if (entry === 'separator' || 'heading' in entry || !('onSelect' in entry) || entry.disabled === true) return entry;
  const hint = TOP_HINTS[entry.id];
  return hint === undefined ? entry : { ...entry, hint };
}

/**
 * M3's first rows: one to three for what the agent is doing now, with the ids of the body rows they stand for. Each
 * opens where to act or does only what it says: Interrupt and Pause are Run's own rows brought up, and none answers,
 * approves or nudges the agent.
 */
function stateRows(input: AgentTileMenuInput, run: readonly ModelEntry[]): { rows: ModelEntry[]; replaces: string[] } {
  const { nodeId, agent, clickOpens, review, actions } = input;
  const open = () => openAgentTile(clickOpens, actions, nodeId, agent);
  const openRow = (hint?: string): ModelEntry => ({ id: 'open', label: 'Open', icon: <SquareArrowOutUpRight />, ...(hint === undefined ? {} : { hint }), onSelect: open });
  const just = (rows: ModelEntry[]) => ({ rows: rows.map(withTopHint), replaces: [] });
  switch (tileMenuState(input)) {
    case 'thinking':
      return just([{ id: 'watch', label: 'Watch it work', icon: <Eye />, hint: 'Opens its session; changes nothing', onSelect: open }, ...rowsWithId(run, 'interrupt')]);
    case 'needs-you':
      // Pause would put to sleep an agent that waits on you, so it is taken out of Run too.
      return { rows: nextStep(input), replaces: ['pause'] };
    case 'paused':
      return just(nextStep(input));
    case 'waiting': {
      // One its clock wakes leads with Wake now and its clock's rows.
      if (wakeAct(agent) === 'run-now') return just(nextStep(input));
      const on = waitsOn(input)!;
      return { rows: [{ id: 'waits-on', label: 'Show what it waits on', icon: <Eye />, hint: on.hint, onSelect: on.show ?? open }], replaces: on.replaces === undefined ? [] : [on.replaces] };
    }
    case 'idle': {
      const docIn = agent.reviewOf !== null && review?.status === 'ready' ? nextStep(input) : [];
      return just([...docIn, openRow(), ...rowsWithId(run, 'pause')]);
    }
    case 'done': {
      const [pr] = agent.pullRequests;
      const finished: ModelEntry[] = [
        ...(pr === undefined ? [] : [{ id: 'open-pr', label: `Open pull request #${pr.number}`, icon: <GitPullRequest />, hint: pr.title, onSelect: () => actions.openPullRequest(agent, pr) }]),
        ...rowsWithId(reviewEntries(input), 'open-review'),
      ];
      // A done agent's Wake starts it again here, before what it left.
      return just([...wakeEntries(agent, actions), ...(finished.length > 0 ? finished : [openRow()])]);
    }
    case 'failed':
      return just([...wakeEntries(agent, actions), openRow('Opens it, to see what failed')]);
  }
}

/**
 * An agent tile's menu as the menu bar's Agent menu shows it: its Agent ▸ is "Selected agent" there, not an Agent inside
 * Agent. The tile's own menu keeps Agent ▸.
 */
export function menuBarAgentEntries(entries: readonly ModelEntry[]): ModelEntry[] {
  return entries.map((entry) => (entry !== 'separator' && !('heading' in entry) && entry.id === 'agent' && 'entries' in entry ? { ...entry, label: 'Selected agent' } : entry));
}

/** A tile's menu with no Rename, at any depth: for a tile whose name is not its own to change. */
export const withoutRename = (entries: readonly ModelEntry[]): ModelEntry[] => without(entries, new Set(['rename']));
/** The rows without those `ids`, in submenus too, tidied of the separators and headings left with nothing. */
export const withoutRows = (entries: readonly ModelEntry[], ids: readonly string[]): ModelEntry[] => without(entries, new Set(ids));

/** The menu without the rows `taken` names, at any depth: no heading left over nothing, no separator left at an end or doubled, no empty group. */
function without(entries: readonly ModelEntry[], taken: ReadonlySet<string>): ModelEntry[] {
  const kept = entries.flatMap((entry): ModelEntry[] => {
    if (entry === 'separator' || 'heading' in entry) return [entry];
    if (taken.has(entry.id)) return [];
    if (!('entries' in entry) || entry.disabled === true) return [entry];
    const rows = without(entry.entries, taken);
    return rows.length === 0 ? [] : [{ ...entry, entries: rows }];
  });
  const tidy: ModelEntry[] = [];
  for (const [index, entry] of kept.entries()) {
    const next = kept[index + 1];
    if (entry !== 'separator' && 'heading' in entry && (next === undefined || next === 'separator' || 'heading' in next)) continue;
    if (entry === 'separator' && (tidy.length === 0 || tidy.at(-1) === 'separator')) continue;
    tidy.push(entry);
  }
  while (tidy.at(-1) === 'separator') tidy.pop();
  return tidy;
}

/**
 * An agent tile's menu under Classic (M3), from its ⋯ and a right-click alike: one to three rows for what it is doing
 * now, then Open, Pop out, Run ▸, Agent ▸ (Settings, Review & gate and Copy, under headings), Board ▸ (the tiles it is
 * linked to, and Arrange), Ask Claude and Delete, with no row of the first block again. Ten rows at most; no row
 * answers, approves or nudges the agent. Simplified keeps `agentTileMenu`.
 */
export function stateTileMenu(input: AgentTileMenuInput): ModelEntry[] {
  const { agent, rename, actions, board, related } = input;
  const run = runEntries(agent, actions);
  const first = stateRows(input, run);
  const reviewGate = reviewGateEntries({ ...input, related: [] });
  const shows = related.map((tile): ModelEntry => ({ id: `show-${tile.sessionId}`, label: tile.label, icon: <LocateFixed />, onSelect: () => board.show(tile.sessionId) }));
  const body: ModelEntry[] = [
    agentOpen(input),
    { id: 'pop-out', label: 'Pop out', icon: <SquareArrowOutUpRight />, onSelect: () => actions.popOutAgent(agent) },
    'separator',
    ...(run.length === 0 ? [] : [{ id: 'run', label: 'Run', icon: <Play />, entries: run }]),
    {
      id: 'agent',
      label: 'Agent',
      icon: <UserRound />,
      entries: [{ heading: 'Settings' }, ...settingsEntries(agent, rename, actions), 'separator', { heading: 'Review & gate' }, ...reviewGate, 'separator', { heading: 'Copy' }, ...copyEntries(input), savePrefabEntry(input)],
    },
    { id: 'board', label: 'Board', icon: <LayoutTemplate />, entries: [...shows, ...(shows.length > 0 ? ['separator' as const] : []), ...arrangeEntries(input)] },
    'separator',
    { id: 'ask', label: 'Ask Claude about it…', icon: <Sparkles />, shortcut: keyText('make.askClaude'), hint: 'Sends nothing until you press Ask', onSelect: board.askClaude },
    'separator',
    { id: 'delete', label: 'Delete agent', icon: <Trash2 />, danger: true, shortcut: keyText('tile.delete'), onSelect: () => actions.deleteAgent(agent.sessionId) },
  ];
  return [...first.rows, 'separator', ...without(body, new Set([...menuIds(first.rows), ...first.replaces]))];
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

/**
 * An agent's Role ▸: None, Orchestrator and the built-in roles, and its own custom role if it has one, its own ticked.
 * Only the role changes, at once: its badge, and what goes by the role (an orchestrator's place at the top of its zone,
 * the Captain's list), follow; the session is neither restarted nor sent a template. Its last row, With its template ▸,
 * gives the same roles and sends the role's template to the agent as a message too.
 */
function roleEntry(agent: Agent, actions: Pick<AgentMenuActions, 'setRole'>): ModelEntry {
  const orchestrator = isOrchestratorRole(agent.roleName);
  const custom = agent.roleName !== null && !orchestrator ? agent.roleName : null;
  const row = (id: string, label: string, role: string | null, ticked: boolean, hint?: string): ModelEntry => ({
    id,
    label,
    icon: ticked ? <Check /> : <span className="agent-setup-blank" aria-hidden />,
    ...(hint === undefined ? {} : { hint }),
    onSelect: () => actions.setRole(agent.sessionId, role),
  });
  const sending = (id: string, label: string, role: string): ModelEntry => ({
    id: `send-${id}`,
    label,
    icon: <span className="agent-setup-blank" aria-hidden />,
    onSelect: () => actions.setRole(agent.sessionId, role, true),
  });
  return {
    id: 'role',
    label: 'Role',
    icon: <UserRound />,
    detail: agent.role === null ? 'None' : roleText(agent.role, agent.roleName),
    entries: [
      { heading: 'Only its role changes; it carries on' },
      row('none', 'None', null, agent.role === null),
      row('orchestrator', 'Orchestrator', ORCHESTRATOR_ROLE, orchestrator),
      ...BUILT_IN_ROLES.map((role) => row(role, ROLE_LABELS[role], role, agent.role === role && agent.roleName === null)),
      ...(custom === null ? [] : [row('custom', custom, custom, true)]),
      'separator',
      {
        id: 'with-template',
        label: 'With its template',
        icon: <SendHorizontal />,
        entries: [
          { heading: "Gives the role and sends the role's template as a message" },
          sending('orchestrator', 'Orchestrator', ORCHESTRATOR_ROLE),
          ...BUILT_IN_ROLES.map((role) => sending(role, ROLE_LABELS[role], role)),
          ...(custom === null ? [] : [sending('custom', custom, custom)]),
        ],
      },
    ],
  };
}

/** The roles a running agent can be given by name from its menu, besides Orchestrator and its own custom one. */
const BUILT_IN_ROLES = AGENT_ROLES.filter((role) => role !== 'custom');

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
  /**
   * Cleans it up: a Spine zone's notes and docs go to their agents' bands and its finished tickets to its Done line; a
   * free zone's tiles are laid out in rows, in reading order, its height fitted to them.
   */
  tidy(zone: Zone): void;
  /** Whether the step ⌘Z undoes now is this zone's Clean up. */
  cleanUpUndoable(zone: Zone): boolean;
  /** Undoes the board's last step. */
  undo(): void;
  /** Keeps `spacing` as the zone's, for its Tidy and its orchestrators' arrange, and tidies it at once. */
  setSpacing(zone: Zone, spacing: ArrangeSpacing): void;
  /** Opens Settings, where the spacing new zones take is. */
  openSettings(): void;
  /**
   * Lays the zone out as `choice`: free, by a rule it keeps (lanes, which moves its tiles), or drawn on shelves or in
   * clusters (which moves no tile's saved place).
   */
  setLayoutMode(zone: Zone, choice: ZoneLayoutChoice): void;
  /** Keeps `placement` as where the zone's arrange puts its items of `kind`, from its next arrange on. */
  setPlacement(zone: Zone, kind: ArrangeItemKind, placement: ArrangePlacement): void;
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
  /** Asks for the zone's gate command. */
  editGateCommand(zone: Zone): void;
  /** Opens the zone's role templates. */
  editRoleTemplates(zone: Zone): void;
  /** Opens the prompt box of a crew from the prefab named, in the zone. */
  startCrew(prefab: string, zone: Zone): void;
  /** Opens the app's crew library, one for every board, a crew from it starting in the zone. */
  crewLibrary(zone: Zone): void;
  /** Opens a prefab on its own board to change it (a built-in as its copy), or a new one with `null`. */
  editPrefab(prefab: LibraryPrefab | null): void;
  /** Opens Describe a crew: an agent drafts a prefab, a new one starting in the zone. */
  describeCrew(zone: Zone): void;
  /** Opens the New ticket sheet: one ticket tile, from a ticket prefab, starting in the zone. */
  newTicket(zone: Zone): void;
  /** Adds the zone's stage board, which holds the work its agents started (one to a zone). */
  addStageBoard(zone: Zone): void;
}

/** What a zone's menus do to it: the handlers its tab is given, but for renaming, which its menu starts in place. */
type ZoneMenuActions = Omit<ZoneBindingActions, 'rename'>;

/**
 * Add stage board, in a zone that lays its tiles out where they are put or by a rule (one laid out by status says the
 * same on its shelves): there while it has one, but not to choose.
 */
function stageBoardRows(zone: Zone, has: boolean, actions: Pick<ZoneMenuActions, 'addStageBoard'>): ModelEntry[] {
  if (zone.layoutMode !== 'free') return [];
  return [
    {
      id: 'stage-board',
      label: 'Add stage board',
      icon: <SquareKanban />,
      hint: has ? 'It has one already: drag it where you want it' : 'The work its agents started, by stage: To do, Doing, Waiting for review, Done',
      disabled: has,
      onSelect: () => actions.addStageBoard(zone),
    },
  ];
}

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
 * A Tidy row's state in a zone with a layout rule, on shelves or in clusters: disabled, saying why, since the zone lays
 * itself out (and on shelves or in clusters, a tidy would move the places its tiles are not drawn at). Nothing for a
 * free zone.
 */
export function tidyBlocked(zone: Pick<Zone, 'layoutMode' | 'layoutRule'>): { disabled: true; hint: string } | Record<string, never> {
  if (zone.layoutRule === 'lanes') return { disabled: true, hint: 'The zone lays its tiles out by its rule' };
  if (zone.layoutMode === 'shelves') return { disabled: true, hint: 'Not on status shelves: it would move the tiles folded into stacks' };
  if (zone.layoutMode === 'clusters') return { disabled: true, hint: 'Not in clusters: the zone lays its tiles out itself' };
  return {};
}

/** What a zone's Clean up does, as its row's hint says: a Spine zone gathers and folds; a free one is tidied into rows. */
export const cleanUpHint = (zone: Pick<Zone, 'layoutRule'>): string =>
  zone.layoutRule === 'spine' ? 'Notes to their agents, finished tickets to the Done line' : 'Its tiles in rows, in reading order';

/** A zone's Clean up row, `label` as the menu names it, with its key. */
const cleanUpRow = (zone: Zone, actions: Pick<ZoneMenuActions, 'tidy'>, id: string, label: string): ModelEntry => ({
  id,
  label,
  icon: <Broom />,
  shortcut: keyText('edit.cleanUpZone'),
  hint: cleanUpHint(zone),
  ...tidyBlocked(zone),
  onSelect: () => actions.tidy(zone),
});

/** Undo Clean up, while the zone's last Clean up is the step ⌘Z undoes; nothing otherwise. */
const undoCleanUpRows = (zone: Zone, actions: Pick<ZoneMenuActions, 'cleanUpUndoable' | 'undo'>): ModelEntry[] =>
  actions.cleanUpUndoable(zone) ? [{ id: 'undo-clean-up', label: 'Undo Clean up', icon: <Undo2 />, shortcut: keyText('edit.undo'), onSelect: actions.undo }] : [];

/** Each zone layout's name and what it draws, as the zone's Layout menu offers them. */
const LAYOUT_MODE_LABELS: Record<ZoneLayoutChoice, { label: string; hint: string }> = {
  free: { label: 'Free', hint: 'Each tile where you put it' },
  spine: { label: 'Spine', hint: 'The lead at the left, a band per ticket in columns beside it' },
  lanes: { label: 'Lanes by ticket', hint: 'A lane per ticket, kept as work comes and goes' },
  shelves: { label: 'Status shelves', hint: 'Shelves by status, a stack per ticket' },
  clusters: { label: 'Clusters', hint: "Each ticket's tiles together, what needs you first" },
};

function layoutModeEntries(zone: Zone, actions: Pick<ZoneMenuActions, 'setLayoutMode'>): ModelEntry[] {
  const current = zoneLayoutChoiceOf(zone);
  return ZONE_LAYOUT_CHOICES.map((mode) => ({
    id: `layout-${mode}`,
    label: LAYOUT_MODE_LABELS[mode].label,
    hint: LAYOUT_MODE_LABELS[mode].hint,
    checked: current === mode,
    onSelect: () => actions.setLayoutMode(zone, mode),
  }));
}

/** Each kind of item an arrange places, as the zone's Arrange items menu names it. */
const ITEM_KIND_LABELS: Record<ArrangeItemKind, string> = {
  notes: 'Agent notes',
  files: 'Files and cards',
  clocks: 'Clocks',
  todos: 'To-dos',
  queues: 'Queues',
  memory: 'Memory',
  steps: 'Steps',
  stickies: 'Stickies',
  shapes: 'Shapes',
  text: 'Text',
};

/** Each place an arrange can put a kind of item, and what it means. */
const PLACEMENT_LABELS: Record<ArrangePlacement, { label: string; hint: string }> = {
  cluster: { label: 'Beside its agent', hint: "In its agent's lane; down the side if no agent here made it" },
  sidebar: { label: 'Down the side', hint: 'One column beside the lanes' },
  top: { label: 'Under the top row', hint: 'Grouped after the top row, before the lanes' },
  stay: { label: 'Where it is', hint: 'Arrange leaves it, and lays the rest out round it' },
};

/**
 * Arrange items ▸: a row per kind of item, saying where the zone's arrange puts it (its own pick, else where every
 * zone does), and in it the places to pick from, the one in use ticked.
 */
function placementRow(zone: Zone, actions: Pick<ZoneMenuActions, 'setPlacement'>): ModelEntry {
  const placements = placementsOf(zone.placements);
  return {
    id: 'placements',
    label: 'Arrange items',
    icon: <LayoutGrid />,
    hint: 'Where an arrange puts each kind',
    entries: ARRANGE_ITEM_KINDS.map((kind) => ({
      id: `place-${kind}`,
      label: ITEM_KIND_LABELS[kind],
      detail: PLACEMENT_LABELS[placements[kind]].label,
      entries: ARRANGE_PLACEMENTS.map((placement) => ({
        id: `place-${kind}-${placement}`,
        label: PLACEMENT_LABELS[placement].label,
        hint: PLACEMENT_LABELS[placement].hint,
        checked: placements[kind] === placement,
        onSelect: () => actions.setPlacement(zone, kind, placement),
      })),
    })),
  };
}

/**
 * The tab's Clean up ▾ menu: Clean up now, the zone's layout and spacing, and where the spacing for new zones is set, named as it is
 * (`newZones`, read as the menu opens).
 */
export function tidyMenu(zone: Zone, newZones: ArrangeSpacing | undefined, actions: Pick<ZoneMenuActions, 'tidy' | 'setSpacing' | 'openSettings' | 'setLayoutMode'>): ModelEntry[] {
  return [
    cleanUpRow(zone, actions, 'tidy', 'Clean up now'),
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
    // The zone's own ⋯ has Clean up already; while it clones, ⋯ holds only what folded.
    tidy: clone === null ? undefined : cleanUpRow(zone, actions, 'tab-tidy', 'Clean up'),
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
  /** Whether it has its stage board already. */
  stageBoard?: boolean;
  actions: ZoneMenuActions;
}

/**
 * A zone's ⋯ menu: its folded chips, then Tidy, spacing, rename, colour, fill, its binding, its agents' settings, and
 * Delete. While it clones, it holds only what folded.
 */
export function zoneMenu({ zone, folded, themeFill, rename, stageBoard = false, actions }: ZoneMenuInput): ModelEntry[] {
  if (zone.clone !== null) return [...folded];
  const unbound = zone.repoRoot === null;
  // A crew is one more way to start something: under what starts an agent or a shell, where those folded onto this menu.
  const afterStarts = folded.findLastIndex((entry) => entry !== 'separator' && 'id' in entry && (entry.id === 'tab-new-agent' || entry.id === 'tab-new-shell')) + 1;
  return [
    cleanUpRow(zone, actions, 'tidy', 'Clean up'),
    ...undoCleanUpRows(zone, actions),
    'separator',
    ...folded.slice(0, afterStarts),
    crewRow(zone, actions, 'New crew'),
    ...folded.slice(afterStarts),
    'separator',
    // One row for both, so ⋯ grows no taller for the layout.
    {
      id: 'spacing',
      label: 'Layout and spacing',
      icon: <Rows3 />,
      entries: [{ heading: 'Layout' }, ...layoutModeEntries(zone, actions), 'separator', { heading: 'Spacing' }, ...spacingEntries(zone, actions)],
    },
    placementRow(zone, actions),
    ...stageBoardRows(zone, stageBoard, actions),
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
  /** Whether rows use their technical names (Show technical details): "repo", "board MCP". */
  technical: boolean;
  /** The spacing new projects take, named as it is (read as the menu opens). */
  newZones: ArrangeSpacing | undefined;
  /** The fill opacity the theme gives it while it has none of its own, in percent. */
  themeFill: number;
  /** Starts renaming it in place. */
  rename(): void;
  /** Whether it has its stage board already. */
  stageBoard?: boolean;
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

/**
 * Where a New crew's rows go: `start` opens the prompt box of a crew from the prefab named, `library` the library itself.
 * With `edit`, each prefab's row has ✎ (a built-in's, duplicate) to open it on its own board, `edit(null)` a new one.
 */
interface CrewPicks {
  start(prefab: string): void;
  library(): void;
  edit?(prefab: LibraryPrefab | null): void;
  /** Opens Describe a crew, for an agent to draft one. */
  describe?(): void;
}

/** How long a prefab saved is marked new in the menus. */
const NEW_FOR_MS = 24 * 60 * 60 * 1000;

/** A prefab of your own saved in the last day. */
export const isNewPrefab = (prefab: LibraryPrefab, now: number): boolean =>
  !prefab.builtIn && prefab.editedAt !== null && now - Date.parse(prefab.editedAt) < NEW_FOR_MS;

/** A prefab in a few words: how many agents, and the model of the one your prompt starts ("2 · opus"). */
const prefabShape = (prefab: LibraryPrefab): string => {
  const first = prefab.members.find((member) => member.starts === 'prompt') ?? prefab.members[0];
  return [String(prefab.members.length), first?.model ?? first?.harness].filter((part) => part !== undefined).join(' · ');
};

/**
 * Every New crew's rows: a crew from each prefab, each group under its heading (yours first), then the library itself.
 * `why`, if set, says why no crew can start here, on each prefab's row. With `picks.edit`, yours are newest first, each
 * with its shape under it and new for a day, and Make a prefab… sits beside the library.
 */
const prefabEntries = (prefabs: readonly LibraryPrefab[], picks: CrewPicks, why?: string, now = Date.now()): ModelEntry[] => {
  const { edit } = picks;
  const newest = (group: LibraryPrefab[]) =>
    edit === undefined || group[0]?.builtIn !== false ? group : [...group].sort((a, b) => (b.editedAt ?? '').localeCompare(a.editedAt ?? ''));
  return [
    ...prefabGroups(prefabs).flatMap((group): ModelEntry[] => [
      { heading: prefabGroupHeading(group) },
      ...newest(group).map(
        (prefab): ModelEntry => ({
          id: `crew-${prefab.name}`,
          label: prefab.name,
          icon: <CrewFaces members={prefab.members} />,
          ...(why === undefined ? (edit === undefined ? {} : { hint: prefabShape(prefab) }) : { disabled: true, hint: why }),
          ...(edit !== undefined && isNewPrefab(prefab, now) ? { badge: 'new' } : {}),
          ...(edit === undefined
            ? {}
            : {
                aside: prefab.builtIn
                  ? { label: `Duplicate ${prefab.name} to change it`, icon: <Copy />, onSelect: () => edit(prefab) }
                  : { label: `Change ${prefab.name}`, icon: <Pencil />, onSelect: () => edit(prefab) },
              }),
          onSelect: () => picks.start(prefab.name),
        }),
      ),
      'separator',
    ]),
    ...(edit === undefined ? [] : [{ id: 'make-prefab', label: 'Make a prefab…', icon: <Pencil />, onSelect: () => edit(null) }]),
    ...(picks.describe === undefined ? [] : [{ id: 'describe-crew', label: 'Describe a crew…', icon: <MessageSquareText />, onSelect: picks.describe }]),
    { id: 'crew-library', label: edit === undefined ? 'Library…' : 'Crew library…', icon: <LibraryBig />, onSelect: picks.library },
  ];
};

/** New crew where no zone is picked yet: the prompt box that follows asks for one. `onCrew(null)` opens the library. */
export const crewMenu = (prefabs: readonly LibraryPrefab[], onCrew: (prefab: string | null) => void): ModelEntry => ({
  id: 'crew',
  label: 'New crew',
  icon: <Users />,
  entries: prefabEntries(prefabs, { start: onCrew, library: () => onCrew(null) }),
});

/** `prefabEntries` for the library as last known, each crew to start in `zone`. */
const zonePrefabEntries = (zone: Zone, actions: Pick<ZoneMenuActions, 'startCrew' | 'crewLibrary'>, why?: string): ModelEntry[] =>
  prefabEntries(currentPrefabs(), { start: (prefab) => actions.startCrew(prefab, zone), library: () => actions.crewLibrary(zone) }, why);

/** A crew to start in the zone, from the library (`zonePrefabEntries`); `why` says why the zone can start none. */
const crewRow = (zone: Zone, actions: Pick<ZoneMenuActions, 'startCrew' | 'crewLibrary' | 'newTicket'>, label: string, why?: string): ModelEntry => ({
  id: 'crew',
  label,
  icon: <Users />,
  entries: [{ id: 'new-ticket', label: 'New ticket…', icon: <Ticket />, onSelect: () => actions.newTicket(zone) }, 'separator', ...zonePrefabEntries(zone, actions, why)],
});

/**
 * The ▾ beside a zone's + agent: a blank agent first, as + agent itself starts one, then a crew from each prefab in the
 * library as last known (yours first, each group under its heading), then the library itself. `noAgents` says why the
 * zone can start none, on every row that would.
 */
export function newAgentMenu(
  zone: Zone,
  noAgents: string | undefined,
  actions: Pick<ZoneMenuActions, 'startCrew' | 'crewLibrary' | 'editPrefab' | 'describeCrew'> & { newAgent(zone: Zone): void },
  now = Date.now(),
): ModelEntry[] {
  return [
    { id: 'new-agent', label: 'Blank agent', icon: <Plus />, shortcut: '⏎', ...(noAgents === undefined ? {} : { disabled: true, hint: noAgents }), onSelect: () => actions.newAgent(zone) },
    'separator',
    ...prefabEntries(
      currentPrefabs(),
      {
        start: (prefab) => actions.startCrew(prefab, zone),
        library: () => actions.crewLibrary(zone),
        edit: actions.editPrefab,
        describe: () => actions.describeCrew(zone),
      },
      noAgents,
      now,
    ),
  ];
}

const newShellRow = ({ zone, actions }: ProjectMenuInput, label: string): ModelEntry => ({
  id: 'new-shell',
  label,
  icon: <Plus />,
  onSelect: () => actions.newShell(zone),
});

const addIssueRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => ({ id: 'add-issue', label: 'Add issue…', icon: <ListPlus />, detail: zone.tracker?.scope, onSelect: () => actions.addIssue(zone) });

const tidyUpRow = ({ zone, actions }: ProjectMenuInput): ModelEntry => cleanUpRow(zone, actions, 'tidy', 'Clean up');

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
    crewRow(zone, input.actions, 'New crew', input.noAgents),
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
    placementRow(zone, actions),
    ...stageBoardRows(zone, input.stageBoard ?? false, actions),
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
    crewRow(zone, input.actions, 'New crew here', input.noAgents),
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
