import type {
  ChecksState,
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetails,
  PullRequestFile,
  PullRequestRef,
  PullRequestReview,
  PullRequestState,
  TrackerIssue,
  TrackerProject,
  TrackerScope,
} from '@agent-board/tracker';
import type { TrackerProvider } from '@agent-board/tracker/providers';
import pkg from '../package.json' with { type: 'json' };
import { paneIds, type PaneLayout, type SplitDirection } from './pane-layout.ts';
import type { Placement, Surface, WindowLayout } from './window-layout.ts';
import type { GateCleanup, GateRun } from './gate-rules.ts';
import type { AgentFace, AgentPose, AgentProp, CharacterSet } from './character.ts';

export type { PaneLayout, SplitDirection };
export type { GateCleanup, GateRun, GateRunStatus } from './gate-rules.ts';
export type { GateStep, GateStepStatus } from './gate-output.ts';
export type {
  ChecksState,
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetails,
  PullRequestFile,
  PullRequestRef,
  PullRequestReview,
  PullRequestState,
  TrackerIssue,
  TrackerProject,
  TrackerProvider,
  TrackerScope,
};
// The provider table has no Node imports, so clients (the app's renderer) can use it too.
export { isTrackerProvider, shortIssueId, TRACKER_PROVIDERS } from '@agent-board/tracker/providers';
export { pullRequestOfUrl } from '@agent-board/tracker/pull-request-ref';
import { isTrackerProvider } from '@agent-board/tracker/providers';

/**
 * The daemon speaks JSON-RPC 2.0 over its socket, one JSON message per line. Besides responses it pushes events as
 * notifications: `{"jsonrpc":"2.0","method":"event","params":<DaemonEvent>}`.
 */
export const DAEMON_VERSION: string = pkg.version;

/** Bumped on any breaking change to methods or events, so an app can tell it is talking to an incompatible daemon. */
export const PROTOCOL_VERSION = 1;

/** Which commit an app and its daemon were built from, so bug reports and mismatches name one. */
export interface BuildInfo {
  /** Short git SHA. */
  sha: string;
  /** The commit's date, ISO 8601. */
  date: string;
}

/** Whether a daemon runs the same build as the app: a daemon of unknown build (null) never does. */
export function sameBuild(app: BuildInfo, daemon: BuildInfo | null): boolean {
  return daemon !== null && daemon.sha === app.sha;
}

/** A build as people should quote it: `abc1234 · 2026-01-01`. */
export function describeBuild(build: BuildInfo | null): string {
  return build === null ? 'unknown build' : `${build.sha} · ${build.date.slice(0, 10)}`;
}

/** `1 running session`, `2 running sessions`: what stopping a daemon would end. */
export function runningSessions(count: number): string {
  return count === 1 ? '1 running session' : `${count} running sessions`;
}

export interface DaemonHealth {
  version: string;
  /** The build the daemon runs, or null if it was started without one (tests, older daemons). */
  build: BuildInfo | null;
  protocolVersion: number;
  pid: number;
  /** The database's `PRAGMA user_version` after migrations. */
  schemaVersion: number;
  /** Port of the hook ingress on 127.0.0.1. */
  hookPort: number;
  startedAt: string;
  /** Connected clients, including the caller. */
  clients: number;
  liveSessions: number;
  /** The home directory loose shells start in, which a shell's folder chip shows as `~`. */
  homeDir: string;
  /** The `agent-board` CLI launcher the daemon wrote (ADR-0010), which Settings links into `~/.local/bin`; null for none. */
  cliPath: string | null;
}

/**
 * A coloured region of the board bound to one local git repo, optionally scoped to a folder inside it; or, while
 * unbound, a plain group with a name and a colour.
 */
export interface Zone {
  id: string;
  /**
   * `repo` when bound to the whole repo, `folder` when scoped to a sub-folder, `unbound` for a group: a zone bound to
   * no repo, until it is bound (and again once it is unbound).
   */
  kind: ZoneKind;
  /** Absolute, symlink-free path of the repo's working tree; null while unbound. */
  repoRoot: string | null;
  /** The folder inside `repoRoot`, `/`-separated; empty for a repo or unbound zone. */
  folder: string;
  /** The label on the zone's tab. */
  name: string;
  /** `#rrggbb`. */
  color: string;
  /** How much of its colour fills it, in percent (see `ZONE_FILL_OPACITY`); null for the theme's own. */
  fillOpacity: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Whether its Codex agents start with `--dangerously-bypass-hook-trust` (ADR-0004), so agent-board's hooks run
   * without review. On by default. Off, Codex asks the user to review them once, in the agent's terminal.
   */
  codexBypassHookTrust: boolean;
  /**
   * Whether Claude's trust screen (`Agent.trustFolder`) is answered by the daemon, as the user's click on Trust folder
   * would, for the agents started in it: only in this zone's own folder and the worktrees made under it. Off by default;
   * the user turns it on, when adding the zone or from its menu. Does nothing for a zone with no repo.
   */
  trustsFolder: boolean;
  /**
   * Whether agents started from it get the board MCP server (`agent-board mcp`, ADR-0010), which tells them they are on
   * agent-board. On by default. Every session gets the `agent-board` CLI and its env either way.
   */
  boardMcp: boolean;
  /**
   * Whether the agents the user starts in it may orchestrate in it: each starts with `orchestrate` `zone`,
   * which holds while its tile is in this zone and this stays on. On by default. Turned off, no agent in it orchestrates
   * any more, whoever let it. An agent an orchestrator starts never orchestrates.
   */
  agentsOrchestrate: boolean;
  /**
   * The merge gate: the command that checks an agent's work before it is merged, such as `pnpm check:local`, run
   * in the agent's worktree only when the user asks; null for none. It runs through `sh -c` (`gateCommandArgv`), and may
   * mark its steps (ADR-0013).
   */
  gateCommand: string | null;
  /** Where the zone's issues come from, or null if it has no tracker. */
  tracker: ZoneTracker | null;
  /** How far apart a Tidy, and an orchestrator's arrange, put what is in it (`SPACING_GAPS`). */
  spacing: ArrangeSpacing;
  /** How it lays out what it holds (`ZONE_LAYOUT_MODES`). Free until set, for a new zone too. */
  layoutMode: ZoneLayoutMode;
  /**
   * Whether it is folded to a chip while it is not needed (`zone.fold`). Its place and size stay as they were, so
   * unfolding puts it back exactly; its agents were paused when it folded, and unfolding wakes none unless asked.
   */
  folded: boolean;
  /** The clone it waits for, while the daemon clones its repo; null once it is bound, and for every other zone. */
  clone: ZoneClone | null;
  /**
   * Whether it is bound to a whole repo the daemon cloned into its repos folder (`<repos dir>/<owner>/<repo>`), which
   * deleting the zone can delete too (`zone.dissolve` with `deleteClone`). False for every other zone.
   */
  managedClone: boolean;
  /**
   * An unbound zone's default repo: a repo's root, or a folder in one, that agents started in it without a
   * repo of their own are cut from, and its shells start in. Null for none, and for every bound zone.
   */
  defaultRepo: string | null;
  /**
   * A group's own folder, outside git: where an agent started in the group runs when it has no repo (none given, and no
   * default repo). The folder outside git the zone was added for (`zone.add`), else one the app makes in its data
   * directory on first use. Null for every bound zone.
   */
  groupFolder: string | null;
  /** Whether `groupFolder` is the folder of the user's the zone was added for, which `zone.initRepo` can make a repo. */
  userFolder: boolean;
  createdAt: string;
}

/**
 * A zone as it can be made again (`zone.restore`): what a user set on it, not what is derived or in flight. A zone that
 * was bound to a repo has the `repoRoot` and `folder` it was bound to; a group has neither, and its `groupFolder`.
 */
export type ZoneSnapshot = Pick<
  Zone,
  'id' | 'name' | 'color' | 'fillOpacity' | 'x' | 'y' | 'width' | 'height' | 'codexBypassHookTrust' | 'boardMcp' | 'agentsOrchestrate' | 'gateCommand' | 'tracker' | 'defaultRepo'
> &
  Partial<Pick<Zone, 'repoRoot' | 'folder' | 'spacing' | 'groupFolder' | 'trustsFolder' | 'layoutMode'>>;

/** What `zone.restore` needs to make `zone` again: the fields of a `ZoneSnapshot`, and no others. */
export function zoneSnapshot(zone: ZoneSnapshot): ZoneSnapshot {
  const { id, name, color, fillOpacity, x, y, width, height, codexBypassHookTrust, boardMcp, agentsOrchestrate, gateCommand, tracker, defaultRepo, repoRoot, folder, spacing, groupFolder, trustsFolder, layoutMode } = zone;
  return { id, name, color, fillOpacity, x, y, width, height, codexBypassHookTrust, boardMcp, agentsOrchestrate, gateCommand, tracker, defaultRepo, repoRoot, folder, spacing, groupFolder, trustsFolder, layoutMode };
}

/**
 * A GitHub repo the daemon is cloning for a zone (`zone.clone`). The zone stays unbound, and starts no agent, until the
 * clone finishes and it is bound to `path`.
 */
export interface ZoneClone {
  /** `owner/repo`. */
  repo: string;
  /** The folder it clones into, which the daemon made for it. */
  path: string;
  /** What git says it is doing (`Receiving objects`), or null before it says anything. */
  phase: string | null;
  /** How far through `phase` it is, or null when git gives no figure. */
  percent: number | null;
}

/** What every way of adding a zone takes besides its source: where it goes, and optionally its look and tracker. */
export interface NewZoneParams {
  x: number;
  y: number;
  /** `DEFAULT_ZONE_SIZE` without; at least `MIN_ZONE_SIZE`. */
  width?: number;
  height?: number;
  /** Named after its repo (or folder) without. */
  name?: string;
  /** `#rrggbb`; the least-used of `ZONE_COLORS` without. */
  color?: string;
  /** A tracker scope to bind it to at once, checked as `zone.setTracker` checks it. */
  tracker?: ZoneTracker;
  /** Whether Claude's trust screen is answered for its agents (`Zone.trustsFolder`); off without. Ignored for a group. */
  trustsFolder?: boolean;
}

/** A folder a zone was made for before, which Add zone offers again. */
export interface RecentFolder {
  /** Absolute: a repo's root, or a folder inside one. */
  path: string;
  /** Its folder name. */
  name: string;
  /** The branch checked out there, or null for a detached HEAD. */
  branch: string | null;
  /** When a zone was last made for it. */
  usedAt: string;
  /** Whether a zone on the board is bound to it now. */
  onBoard: boolean;
}

/** A GitHub repo gh can see, as Add zone offers it. */
export interface GitHubRepoSource {
  /** `owner/repo`, as GitHub spells it. */
  repo: string;
  name: string;
  description: string | null;
  /** A clone of it on this machine the daemon knows of (a zone's or a recent folder's), or null. */
  localPath: string | null;
  /** Where `zone.clone` would clone it: `<repos dir>/<owner>/<repo>`. */
  clonePath: string;
  /** Whether `localPath` is a copy `zone.findCopies` found, rather than one a zone, a recent folder or the managed folder has. */
  foundCopy: boolean;
  /** Whether a zone on the board is bound to its local clone. */
  onBoard: boolean;
}

/** What a repo's own checkout is on, and whether it holds uncommitted changes. */
export interface CheckoutState {
  /** The branch checked out, or null on a detached HEAD. */
  branch: string | null;
  /** The repo's default branch, or null when it can't be told. */
  defaultBranch: string | null;
  /** Whether the checkout has uncommitted changes, untracked files included. */
  dirty: boolean;
}

/** A folder the user picked, once the daemon has looked at it. */
export interface CheckedFolder {
  /** The folder, resolved: a repo's root, or a folder inside it. */
  path: string;
  /** The root of the git repo it is in, or null for a folder outside git. */
  repoRoot: string | null;
  /** The lowercase `owner/repo` of that repo's GitHub `origin`, or null when it has none. */
  gitHubRepo: string | null;
  /** The name a zone for it gets: the repo's, then the folder in it (`monorepo/apps/web`); a folder outside git's own. */
  name: string;
}

export type ZoneKind = 'repo' | 'folder' | 'unbound';

/**
 * How an unbound zone is bound: `repo` to an existing git repo, or a folder inside one; `project` to a new repo, made
 * by `git init` in an empty or new folder, with an empty first commit so worktrees can branch from it.
 */
export type ZoneBinding = 'repo' | 'project';

/** Zone tints, handed out least-used first so neighbouring zones differ. The first eight are the original palette. */
export const ZONE_COLORS = [
  '#4c6ef5',
  '#12b886',
  '#f59f00',
  '#e64980',
  '#7950f2',
  '#15aabf',
  '#fa5252',
  '#82c91e',
  '#fd7e14',
  '#40c057',
  '#be4bdb',
  '#fcc419',
  '#339af0',
  '#a0785a',
  '#748ffc',
  '#495057',
];

/** What each of `ZONE_COLORS` is called, for people who pick one by name, such as with a screen reader. */
export const ZONE_COLOR_NAMES: Readonly<Record<string, string>> = {
  '#4c6ef5': 'Blue',
  '#12b886': 'Teal',
  '#f59f00': 'Amber',
  '#e64980': 'Pink',
  '#7950f2': 'Violet',
  '#15aabf': 'Cyan',
  '#fa5252': 'Red',
  '#82c91e': 'Lime',
  '#fd7e14': 'Orange',
  '#40c057': 'Green',
  '#be4bdb': 'Grape',
  '#fcc419': 'Yellow',
  '#339af0': 'Sky',
  '#a0785a': 'Brown',
  '#748ffc': 'Periwinkle',
  '#495057': 'Graphite',
};

/** The fill opacity a zone's slider offers, in percent: 0 is outline only. */
export const ZONE_FILL_OPACITY = { min: 0, max: 40, step: 2 } as const;

/** Whether `value` is a fill opacity a zone can have: a whole step of `ZONE_FILL_OPACITY`. */
export function validZoneFillOpacity(value: unknown): value is number {
  const { min, max, step } = ZONE_FILL_OPACITY;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max && value % step === 0;
}

/** An agent a fold or an unfold left as it was. */
export interface ZoneFoldLeft {
  sessionId: string;
  name: string;
  /** The reason alone, to show beside its name: "it is mid-turn: finish its turn first", "its worktree is gone". */
  why: string;
}

/** What folding a zone did: the agents it paused (by session id), and those it could not, which stay live. */
export interface ZoneFoldResult {
  zone: Zone;
  paused: string[];
  kept: ZoneFoldLeft[];
}

/**
 * What unfolding a zone did: the agents it woke (by session id; none unless asked), and those its fold paused that
 * would not wake when asked, still paused.
 */
export interface ZoneUnfoldResult {
  zone: Zone;
  woken: string[];
  asleep: ZoneFoldLeft[];
}

/** A zone's settings. */
export interface ZoneSettings {
  codexBypassHookTrust: boolean;
  trustsFolder: boolean;
  boardMcp: boolean;
  agentsOrchestrate: boolean;
  gateCommand: string | null;
  spacing: ArrangeSpacing;
  layoutMode: ZoneLayoutMode;
}

/**
 * How a zone lays out what it holds (`Zone.layoutMode`): `free`, each tile where it was put; `shelves`, its work drawn
 * as stacks on To do, Doing, Waiting and Done shelves under a head row of its leads and shells; `clusters`, each unit of
 * work's tiles drawn together, what needs the user first. Free until the user (or an agent) picks.
 */
export const ZONE_LAYOUT_MODES = ['free', 'shelves', 'clusters'] as const;
export type ZoneLayoutMode = (typeof ZONE_LAYOUT_MODES)[number];

/** One window of plan usage, from a reading: how much of it is used, in percent, and when it resets. */
export interface UsageWindow {
  usedPercent: number;
  remainingPercent: number;
  /** ISO time; null when the reading didn't say. */
  resetsAt: string | null;
}

/**
 * The newest plan usage reading: the 5-hour and weekly windows, as Claude Code passes them to its status line. Read
 * from what Claude agents' status lines post, never by asking anyone, so it is only as new as the last Claude agent's
 * status line. A window is null when no reading carried it, and both are with no reading yet.
 */
export interface UsageReading {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** When it was read; null with no reading yet. */
  readAt: string | null;
  /** Whether it is too old, or one of its windows has reset since, to go by: always true with no reading. */
  stale: boolean;
}

/** How old a usage reading may be before it is stale. */
export const USAGE_STALE_MS = 15 * 60_000;

/**
 * How far apart a zone's Tidy and an orchestrator's arrange in it put things: compact, normal (the gaps arrange always
 * had) or roomy. Each zone keeps its own; a new zone takes the default in the settings (`arrangeSpacing`).
 */
export const ARRANGE_SPACINGS = ['compact', 'normal', 'roomy'] as const;
export type ArrangeSpacing = (typeof ARRANGE_SPACINGS)[number];
/** The spacing a new zone takes until the settings say otherwise. */
export const DEFAULT_ARRANGE_SPACING: ArrangeSpacing = 'roomy';

/** A zone's issue tracker: a provider and a scope in it, such as Linear team `ACME`. */
export interface ZoneTracker {
  provider: TrackerProvider;
  /** The Linear team key, the GitHub `owner/repo`. */
  scope: string;
  /** Narrows the zone's issues to one project of the scope (a Linear project's ID); absent for all of the scope. */
  project?: string;
}

/** The issue an agent is linked to, as it was when linked. */
export type LinkedIssue = Pick<TrackerIssue, 'provider' | 'id' | 'title' | 'url'>;

/**
 * An issue card's data: the tracker issue as it was when the card was made. An agent linked to the same issue is drawn
 * fed by the card, along an "issue brief" flow edge.
 */
export type IssueCardData = Pick<TrackerIssue, 'provider' | 'id' | 'title' | 'url' | 'state'>;

/**
 * What is wrong with `data` as an issue card's, or undefined if it is one: a tracker provider, a non-empty ID, a title,
 * an https URL and a state. The daemon refuses a card that fails it; the app draws none.
 */
export function issueCardProblem(data: Record<string, unknown>): string | undefined {
  const owner = 'an issue card';
  if (!isTrackerProvider(data.provider)) return `${owner}'s provider must be a tracker provider`;
  for (const key of ['id', 'title', 'state'] as const) {
    const value = data[key];
    if (typeof value !== 'string' || (key === 'id' && value === '')) return `${owner}'s ${key} must be a string`;
  }
  if (typeof data.url !== 'string' || !/^https:\/\/[^\s]+$/.test(data.url)) return `${owner}'s url must be an https URL`;
  return undefined;
}

/** `data` as an issue card's, or undefined if it isn't one (see `issueCardProblem`). */
export function issueCardData(data: Record<string, unknown>): IssueCardData | undefined {
  if (issueCardProblem(data) !== undefined) return undefined;
  const { provider, id, title, url, state } = data as unknown as IssueCardData;
  return { provider, id, title, url, state };
}

export const DEFAULT_ZONE_SIZE = { width: 720, height: 480 };

/**
 * How the board slots session tiles in a zone (`board-layout.ts` is the one that does it; its tests pin these): a
 * tile, the padding round a zone's tiles, the gap between them, and the room above a row for subagent characters.
 */
export const TILE_SLOT = { width: 256, height: 136, padding: 20, gap: 16, perchRoom: 24 };

/** The Unsorted group's width when the daemon makes it: two tiles a row. */
export const UNSORTED_GROUP_WIDTH = 2 * TILE_SLOT.padding + 2 * TILE_SLOT.width + TILE_SLOT.gap;

/** Its height for `tileCount` tiles in rows of two, at least one row: what the board slots need. */
export function unsortedGroupHeight(tileCount: number): number {
  const rows = Math.ceil(Math.max(tileCount, 1) / 2);
  const rowStep = TILE_SLOT.perchRoom + TILE_SLOT.height + TILE_SLOT.gap;
  return TILE_SLOT.padding + TILE_SLOT.perchRoom + (rows - 1) * rowStep + TILE_SLOT.height + TILE_SLOT.gap + TILE_SLOT.padding;
}
export const MIN_ZONE_SIZE = { width: 240, height: 160 };

/** The most room a folded zone takes on the board: a chip, where its top left corner is. Its saved size stays as it was. */
export const FOLDED_ZONE_SIZE = { width: 260, height: 48 };

/**
 * The room a zone takes on the board: its saved size, or folded, its chip's, which is never wider than the zone, so
 * folding one puts it on no neighbour.
 */
export function drawnZoneSize(zone: Pick<Zone, 'folded' | 'width' | 'height'>): { width: number; height: number } {
  return zone.folded ? { width: Math.min(FOLDED_ZONE_SIZE.width, zone.width), height: FOLDED_ZONE_SIZE.height } : { width: zone.width, height: zone.height };
}

/** Where a zone sits on the board and how big it is. */
export interface ZoneLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The kinds of board item. Each is drawn by its own node type on the board. An `agent-note` is a note an agent wrote
 * never one of the user's stickies. A `clock` is a schedule (`ClockData`). A `crew` is a running crew's card (`CrewCardData`),
 * which the board keeps.
 */
export const BOARD_ITEM_KINDS = ['sticky', 'text', 'shape', 'image', 'link', 'issue', 'agent-note', 'clock', 'document', 'plan', 'steps', 'memory', 'queue', 'crew', 'todo'] as const;
export type BoardItemKind = (typeof BOARD_ITEM_KINDS)[number];

/**
 * A non-session object on the board, such as a sticky note. Inside a zone its position is relative to the zone, so it
 * moves with it; outside every zone (`zoneId` null) it is a board position.
 */
export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  /** The zone it sits in, or null. */
  zoneId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stacking order among items: higher draws on top. */
  z: number;
  /**
   * Its angle in degrees, clockwise about its own centre, in [-180, 180): 0, straight, until the user rotates it. `x`,
   * `y`, `width` and `height` are its unrotated box.
   */
  rotation: number;
  /** What the kind needs, e.g. a sticky note's `StickyData`. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** `degrees` as an item's `rotation` keeps it: in [-180, 180), and a straight item at 0, never -0. */
export function normalisedAngle(degrees: number): number {
  const angle = (((degrees % 360) + 540) % 360) - 180;
  return angle === 0 ? 0 : angle;
}

/**
 * The colours a sticky note can be, the first by default. Stored in the note's data, so content rather than theme, as
 * zones' `ZONE_COLORS` are.
 */
export const STICKY_COLORS = [
  { name: 'Yellow', value: '#fff3a3' },
  { name: 'Orange', value: '#ffd8a8' },
  { name: 'Pink', value: '#fcc2d7' },
  { name: 'Violet', value: '#d0bfff' },
  { name: 'Blue', value: '#a5d8ff' },
  { name: 'Green', value: '#b2f2bb' },
  { name: 'Grey', value: '#e9ecef' },
  { name: 'White', value: '#ffffff' },
] as const;

/** The most characters a sticky note's text may have. */
export const MAX_STICKY_TEXT = 20_000;
/** The most an item's `data` may take, encoded as JSON, in bytes. */
export const MAX_ITEM_DATA_BYTES = 64 * 1024;

/** A new sticky note's size. */
export const STICKY_SIZE = { width: 200, height: 200 };

/** A sticky note's `data`. */
export interface StickyData {
  /** Markdown: bold, italics, lists and links. */
  text: string;
  /** `#rrggbb`, one of the presets. */
  color: string;
}

/** A new agent note's width, and the least height it starts at. */
export const AGENT_NOTE_SIZE = { width: 272, height: 120 };
/** The tallest an agent note grows to show its text: past it, it scrolls. The user can resize it taller. */
export const MAX_AGENT_NOTE_HEIGHT = 480;
/** The least an agent note can be resized to: its tab, a line of text and its footer still fit. */
export const MIN_AGENT_NOTE_SIZE = { width: 200, height: 96 };
/** The most an agent note can be resized to, by hand or `note edit --size`: a few lane slots wide, and a few screenfuls of text tall. */
export const MAX_AGENT_NOTE_SIZE = { width: 1200, height: 3 * MAX_AGENT_NOTE_HEIGHT };

/** The agent that wrote an agent note, as it was then: the note still says who wrote it once its tile has gone. */
export interface AgentNoteAuthor {
  sessionId: string;
  name: string;
  harness: Harness;
  /** What its badge calls it, as `orchestrator` or `reviewer`; null for nothing. */
  role: string | null;
}

/** An agent note's `data`. Keys a later use adds, such as the question an answer answers, are kept. */
export interface AgentNoteData {
  /** Markdown: bold, italics, inline code, lists and links. */
  text: string;
  agent: AgentNoteAuthor;
  /** When its agent last wrote it, ISO 8601. */
  writtenAt: string;
  /** Whether the user has changed its text since its agent last wrote it. */
  editedByUser: boolean;
  /** For an answer: what the user asked. */
  asked?: string;
  /**
   * The session of the agent a note an orchestrator wrote is about (its cluster's implementer, or the tile it was put
   * beside): the board tethers the note to that tile, not to its author's. Absent, it tethers to its author.
   */
  about?: string;
  /** For an Ask Claude answer: the changes to the diagram it suggests, drawn as ghosts until accepted or dismissed. */
  suggestions?: SuggestedEdit[];
}

/**
 * One change an Ask Claude answer suggests to the diagram it was asked about: new shapes and arrows, drawn dashed on the
 * board until the user accepts it (they become real, as one undo step) or dismisses it.
 */
export interface SuggestedEdit {
  /** Its number on the board, from 1. */
  id: string;
  /** A few words: "Outbox". */
  title: string;
  shapes: SuggestedShape[];
  arrows: SuggestedArrow[];
}

/** A shape a suggestion adds, on the board: its top-left and size in board px. */
export interface SuggestedShape {
  /** What its suggestion's arrows call it. */
  key: string;
  shape: ShapeType;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An end of a suggested arrow: an object already on the board, or one of its suggestion's shapes, by key. */
export type SuggestedEnd = { object: { type: ConnectorEndType; id: string } } | { shape: string };

export interface SuggestedArrow {
  from: SuggestedEnd;
  to: SuggestedEnd;
  label: string;
}

/** The most suggestions one answer keeps, and shapes and arrows one suggestion keeps; the rest are dropped. */
export const MAX_SUGGESTIONS = 6;
export const MAX_SUGGESTED_SHAPES = 6;
export const MAX_SUGGESTED_ARROWS = 8;

/**
 * A selection as an Ask Claude agent reads it: its objects (`nodes`, each with a short id such as `n1`, its kind, text
 * and box in board px from the selection's top-left), the arrows between them (`edges`), and the zones they are in.
 */
export interface SelectionDiagram {
  nodes: SelectionNode[];
  edges: SelectionEdge[];
  groups: SelectionGroup[];
}

export interface SelectionNode {
  id: string;
  /** A board item's kind (`shape`, `sticky`, `text`…), or `agent`, `shell` or `zone`. */
  kind: string;
  /** For a shape, which. */
  shape?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SelectionGroup {
  name: string;
  /** The ids of the nodes in it. */
  nodes: string[];
}

/** A place on the board: in a zone (relative to it) or loose (null). */
export interface BoardPlace {
  zoneId: string | null;
  x: number;
  y: number;
}

/** `master.start`'s: the harness (`claude` by default) and model (`opus` for Claude by default) of a new master. */
export interface StartMasterParams extends TerminalSize {
  harness?: Harness;
  model?: string;
}

/**
 * Ask Claude about a selection: what the user asked, the agent to start, the selection as a picture and a diagram, and
 * where the answer goes.
 */
export interface AskSelectionParams extends TerminalSize {
  /** What to look at: "Review this architecture: risks, gaps, alternatives." */
  question: string;
  /** `claude` by default. */
  harness?: Harness;
  model?: string;
  /** Its role, as `SpawnAgentParams.role`: `architect` by default. */
  role?: string;
  /** The zone the selection is in, whose repo it may read; null for none. */
  zoneId: string | null;
  /**
   * Start it in its zone's repo, the user's checkout, read-only (Claude in plan mode, Codex in its read-only sandbox);
   * else, or with no repo there, in the ask's own folder, outside git. Either way it has no worktree or branch.
   */
  readRepo: boolean;
  /** Ask it to suggest edits, drawn on the diagram as ghosts. */
  suggest: boolean;
  diagram: SelectionDiagram;
  /** The board object each node in `diagram` is, by its id there. */
  objects: Record<string, { type: ConnectorEndType; id: string }>;
  /** The selection's top-left on the board: `diagram`'s (0, 0). */
  origin: { x: number; y: number };
  /** The selected objects alone, drawn as a PNG the app left in `images/incoming`; it is moved away. */
  picturePath: string;
  /** How many of the picture's pixels to a board px: 2 unless the selection was too large to draw that big. */
  pictureScale?: number;
  /** The node the answer's arrow leaves, by its id in `diagram`: the one nearest the note. */
  anchor: string;
  /** Where the answer note goes, its top-left. */
  note: BoardPlace;
  /** Where the agent's tile goes, under the note. */
  tile: BoardPlace;
}

/** The largest image the board takes, in bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * The folder under the data dir where an image pasted into an agent's composer is kept, as `<sha256>.<ext>`, for the
 * agent to read. Not the image store: nothing on the board shows it, so a sweep would take it.
 */
export const PASTED_IMAGES_DIR = 'pasted-images';

/**
 * The image formats the store keeps, by file extension. SVG is left out: it can carry script. `ico` is for link cards'
 * favicons; the board takes the others.
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'ico'] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

/** An image in the daemon's image store, found by the SHA-256 of its bytes. */
export interface ImageRef {
  /** Lowercase hex. */
  sha256: string;
  ext: ImageExtension;
}

/** An image item's `data`: the stored bytes it shows. */
export type ImageData = ImageRef;

/** A tracker issue's or pull request's state, as a link card shows it. */
export interface LinkStatus {
  kind: 'issue' | 'pr';
  /** `ACME-49`, `#34`. */
  id: string;
  /** Its workflow state: `In Progress`, `Open`, `Merged`. */
  state: string;
}

/**
 * A link card's `data`. Only `url` is there at first; the daemon fills in the rest when it has fetched the page, if it
 * can. A page that gives no title leaves the card showing the bare URL.
 */
export interface LinkData {
  /** An https URL. */
  url: string;
  title?: string;
  /** The URL's host, without `www.`. */
  domain?: string;
  /** The page's icon, kept in the image store. */
  favicon?: ImageRef;
  /** For a URL of an issue or pull request in a tracker a zone is bound to. */
  status?: LinkStatus;
}

/** The longest URL a link card takes. */
export const MAX_LINK_URL = 2048;

/** The text sizes of a text item, and the text inside a shape: a heading 1, a heading 2 and body text. */
export const TEXT_SIZES = ['h1', 'h2', 'body'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
/** The font sizes the text style bar offers, px. */
export const TEXT_FONT_SIZES = [12, 14, 16, 20, 24, 32, 48, 64, 96] as const;
/** The smallest and largest font size a text item may have, px. */
export const MIN_TEXT_FONT_SIZE = 8;
export const MAX_TEXT_FONT_SIZE = 200;
/** The font size each `size` was drawn at before text items had a `fontSize`, px. */
export const LEGACY_TEXT_FONT_SIZES: Record<TextSize, number> = { h1: 44, h2: 28, body: 16 };
/** The font size the heading 1, heading 2 and body presets set, px. */
export const TEXT_PRESET_FONT_SIZES: Record<TextSize, number> = { h1: 32, h2: 24, body: 16 };
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** The most characters a text item's, or a shape's, text may have. */
export const MAX_TEXT_LENGTH = 20_000;

/**
 * The theme's colours a shape's outline and text, a text item or a connector can be, in the picker's order: the theme's
 * accent, its text (Ink) and muted text (Grey), then its palette's hues. An item stores the slot, and the board draws it
 * in the theme it shows, so switching theme recolours it.
 */
export const COLOR_SLOTS = ['accent', 'ink', 'grey', 'red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'violet', 'pink'] as const;
export type ColorSlot = (typeof COLOR_SLOTS)[number];

/**
 * What each slot is in the light theme, stored as an item's `#rrggbb` beside its slot, so an app or daemon from before
 * slots still reads it. The colours from before slots are these, so one stored without a slot is read as its slot.
 */
export const SLOT_COLORS: Record<ColorSlot, string> = {
  accent: '#364fc7',
  ink: '#2b2a27',
  grey: '#6f6a60',
  red: '#c92a2a',
  orange: '#d9480f',
  yellow: '#c16400',
  green: '#2f9e44',
  teal: '#087f5b',
  cyan: '#0c8599',
  blue: '#3b5bdb',
  violet: '#6741d9',
  pink: '#c2255c',
};

/**
 * The fills a shape can have, in the picker's order: the tile's own colour, then the slots tinted into it. A shape may
 * also have none (`fill` null).
 */
export const FILL_SLOTS = ['tile', 'accent', 'yellow', 'green', 'teal', 'cyan', 'blue', 'violet', 'pink', 'red', 'orange'] as const;
export type FillSlot = (typeof FILL_SLOTS)[number];

/** A fill slot's stored `#rrggbb`: the fills from before slots for theirs (White for the tile's), else its light tint. */
export const FILL_SLOT_COLORS: Record<FillSlot, string> = {
  tile: '#ffffff',
  accent: '#dfe3f6',
  yellow: '#fff3bf',
  green: '#d3f9d8',
  teal: '#d7ebe5',
  cyan: '#d8ebef',
  blue: '#d0ebff',
  violet: '#e7e1f9',
  pink: '#ffdeeb',
  red: '#f6dddd',
  orange: '#f9e2d9',
};

const slotOf = <Slot extends string>(colors: Record<Slot, string>, color: string): Slot | null =>
  (Object.keys(colors) as Slot[]).find((slot) => colors[slot] === color.toLowerCase()) ?? null;

/** The slot a colour stored without one stands for, or null for a fixed colour: one that is no slot's. */
export const colorSlotOf = (color: string): ColorSlot | null => slotOf(SLOT_COLORS, color);
export const fillSlotOf = (color: string): FillSlot | null => slotOf(FILL_SLOT_COLORS, color);

/** A text item's `data`: free text with no background. */
export interface TextData {
  text: string;
  /** The size before `fontSize`; an item without a `fontSize` takes the one its `size` was drawn at. */
  size: TextSize;
  /**
   * px, from `MIN_TEXT_FONT_SIZE` to `MAX_TEXT_FONT_SIZE`. It wins over `size`, which is left as it was when a font
   * size is picked: read `fontSize`, and `size` only for an item that has none.
   */
  fontSize: number;
  /** The height the user dragged the box to, px, which it is never shorter than; 0 when it is as tall as its text. */
  minHeight: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** `#rrggbb`: `colorSlot`'s, or a fixed colour. */
  color: string;
  /**
   * The theme colour it is drawn in, or null for `color` as it is. Missing in one saved before slots, which reads it
   * from `color` (`colorSlotOf`).
   */
  colorSlot: ColorSlot | null;
  /**
   * False while the text sizes its own width as it is typed; true once the user has resized it, when the width stays
   * and the text wraps.
   */
  wrap: boolean;
}

/**
 * The kinds of shape, in the picker's order: flowchart, architecture and UML. The first four are the shapes
 * from before, under their old names. One stored with a kind this list lacks (a newer app's) draws as a rectangle, and
 * keeps its kind through edits that don't change it.
 */
export const SHAPE_TYPES = [
  'rectangle',
  'rounded',
  'ellipse',
  'diamond',
  'terminator',
  'input-output',
  'predefined-process',
  'document',
  'multi-document',
  'manual-input',
  'delay',
  'preparation',
  'loop-limit',
  'off-page',
  'circle-connector',
  'database',
  'queue',
  'storage',
  'cloud',
  'server',
  'browser',
  'mobile',
  'user',
  'service',
  'external-system',
  'load-balancer',
  'cache',
  'lock',
  'container',
  'note',
  'class',
  'interface-box',
  'component',
  'package',
  'interface',
  'actor',
  'use-case',
  'lifeline',
  'state',
  'start',
  'end',
  'choice',
  'fork-join',
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** The stroke widths of a shape, px; 0 is no outline. */
export const SHAPE_STROKE_WIDTHS = [1, 2.5, 4] as const;

/** A shape's `data`. Its text is centred in it. */
export interface ShapeData {
  shape: ShapeType;
  /** `#rrggbb`, or null for none. */
  fill: string | null;
  /**
   * The theme colour the fill is drawn in, or null for `fill` as it is. Each slot is missing in a shape saved before
   * slots, which reads it from its colour (`fillSlotOf`, `colorSlotOf`).
   */
  fillSlot: FillSlot | null;
  /** `#rrggbb`. */
  stroke: string;
  strokeSlot: ColorSlot | null;
  strokeWidth: number;
  dashed: boolean;
  text: string;
  textSize: TextSize;
  /** The font size in px, or null for the one `textSize` stands for. */
  fontSize: number | null;
  bold: boolean;
  /** Which side the text lines up to. */
  align: TextAlign;
  /** Set in the mono font, for code. */
  mono: boolean;
  /**
   * A class's (or a box interface's) sections under its name, which is `text`, each divided from the one above by a
   * rule. Empty for a kind of shape without them.
   */
  attributes: string;
  methods: string;
  /** `#rrggbb`. */
  textColor: string;
  textColorSlot: ColorSlot | null;
}

/** The sections a shape may have under its text, as keys of its data, in the order they are drawn. */
export const SHAPE_SECTIONS = ['attributes', 'methods'] as const;
export type ShapeSection = (typeof SHAPE_SECTIONS)[number];
/** The kinds of shape that have `SHAPE_SECTIONS` under their name: a class and a box interface. */
export const SECTIONED_SHAPES: readonly ShapeType[] = ['class', 'interface-box'];

/** A new shape's data, as the board draws one dropped from its toolbar: Accent on the tile, a class's sections in mono. */
export const newShapeData = (shape: ShapeType): ShapeData => ({
  shape,
  fill: FILL_SLOT_COLORS.tile,
  fillSlot: 'tile',
  stroke: SLOT_COLORS.accent,
  strokeSlot: 'accent',
  strokeWidth: SHAPE_STROKE_WIDTHS[1],
  dashed: false,
  text: '',
  textSize: 'h2',
  fontSize: null,
  bold: true,
  align: 'center',
  mono: SECTIONED_SHAPES.includes(shape),
  attributes: '',
  methods: '',
  textColor: SLOT_COLORS.ink,
  textColorSlot: 'ink',
});

/**
 * A new board item. Its `z` is above every other item's. A client may pick its `id` (letters, digits and `-`, at most
 * 64), so it can show the item before the daemon answers; otherwise the daemon picks one.
 */
export interface CreateItemParams {
  id?: string;
  kind: BoardItemKind;
  zoneId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its angle, straight (0) if not given. */
  rotation?: number;
  data: Record<string, unknown>;
}

/**
 * A change to a board item: only the fields given change, and `data`'s keys are merged into its data. Moving it to
 * another zone (or out of every zone, with null) without `x` and `y` keeps it where it is on the board.
 */
export type UpdateItemParams = { id: string } & Partial<Omit<BoardItem, 'id' | 'kind' | 'createdAt' | 'updatedAt'>>;

/** The kinds of board object a connector can end on. Each id is that object's own: a zone's, an item's, a session's. */
export const CONNECTOR_END_TYPES = ['zone', 'item', 'agent', 'shell', 'external'] as const;
export type ConnectorEndType = (typeof CONNECTOR_END_TYPES)[number];
/** The side of an object a connector leaves or arrives at: where the hover handle it was dragged from or onto sits. */
export const CONNECTOR_SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type ConnectorSide = (typeof CONNECTOR_SIDES)[number];
export const CONNECTOR_STYLES = ['straight', 'elbow', 'curved'] as const;
export type ConnectorStyle = (typeof CONNECTOR_STYLES)[number];
/**
 * What a line can end in: nothing, an open arrow, a dot, or one of a class diagram's ends (a hollow triangle, a hollow
 * diamond, a filled diamond).
 */
export const CONNECTOR_LINE_ENDS = ['none', 'arrow', 'dot', 'triangle', 'diamond', 'filled-diamond'] as const;
export type ConnectorLineEnd = (typeof CONNECTOR_LINE_ENDS)[number];
/** The most characters a connector's label, or a label at one of its ends, may have. */
export const MAX_CONNECTOR_LABEL = 500;

/**
 * A bend a connector's or flow edge's line passes through: how far it is, on the board, from the middle of the line's
 * two ends (where they meet their objects). So a line whose objects move together keeps its shape, and one whose end
 * moves stretches with it.
 */
export interface EdgePoint {
  x: number;
  y: number;
  /**
   * Set on a curve's one point when it is its bow: the curve is drawn bowed through it. A curve's one point kept
   * without it is a bend from before bows, drawn through it as it always was.
   */
  bow?: true;
}
/** The most bends a line may have. */
export const MAX_EDGE_POINTS = 32;

/** One end of a connector: the object it is fixed to, and the side of it. */
export interface ConnectorEnd {
  type: ConnectorEndType;
  id: string;
  side: ConnectorSide;
}

/**
 * An annotation arrow or line between two board objects. It carries nothing: a flow edge (M2) is the link that
 * delivers an agent's output. It is deleted with either object.
 */
export interface Connector {
  id: string;
  from: ConnectorEnd;
  to: ConnectorEnd;
  style: ConnectorStyle;
  /** What the line ends in at `from`, and at `to`. */
  startEnd: ConnectorLineEnd;
  endEnd: ConnectorLineEnd;
  /** Whether the line is drawn dashed; its ends stay solid. */
  dashed: boolean;
  /** `#rrggbb`, or null for the theme's neutral line. */
  color: string | null;
  /** The text on the middle of the line; empty for none. */
  label: string;
  /** The text by the line's `from` end, and by its `to` end, such as a multiplicity (`0..*`) or a role; empty for none. */
  startLabel: string;
  endLabel: string;
  /** The bends its line passes through, from `from` to `to`; none for the style's own path between its ends. */
  points: EdgePoint[];
  createdAt: string;
  updatedAt: string;
}

/** The fields of a connector that are its look and its labels: what a client can give it beyond its ends and bends. */
export type ConnectorLook = Pick<Connector, 'style' | 'startEnd' | 'endEnd' | 'dashed' | 'color' | 'label' | 'startLabel' | 'endLabel'>;

/**
 * What a connector is drawn as when made without a say in its look: a solid curved line, an arrow at `to`, the theme's
 * neutral, and no labels.
 */
export const DEFAULT_CONNECTOR_LOOK = {
  style: 'curved',
  startEnd: 'none',
  endEnd: 'arrow',
  dashed: false,
  color: null,
  label: '',
  startLabel: '',
  endLabel: '',
} as const satisfies ConnectorLook;

/** The ends and dash of a class diagram's relation: one pick sets all three. */
export type RelationLook = Pick<ConnectorLook, 'startEnd' | 'endEnd' | 'dashed'>;

export interface Relation {
  id: 'association' | 'directed' | 'inheritance' | 'realisation' | 'dependency' | 'aggregation' | 'composition';
  label: string;
  /** Which way it reads, from `from` to `to`, where that is not plain. */
  reads?: string;
  look: RelationLook;
}
export type RelationId = Relation['id'];

/**
 * The relations of a class diagram, as a connector's ends and dash. The line is drawn the way the relation reads, from
 * `from` to `to`: a child to its parent, a client to what it uses, a whole to its parts.
 */
export const RELATIONS: readonly Relation[] = [
  { id: 'association', label: 'Association', look: { startEnd: 'none', endEnd: 'none', dashed: false } },
  { id: 'directed', label: 'Directed', look: { startEnd: 'none', endEnd: 'arrow', dashed: false } },
  { id: 'inheritance', label: 'Inheritance', reads: 'child → parent', look: { startEnd: 'none', endEnd: 'triangle', dashed: false } },
  { id: 'realisation', label: 'Realisation', reads: 'class → interface', look: { startEnd: 'none', endEnd: 'triangle', dashed: true } },
  { id: 'dependency', label: 'Dependency', reads: 'user → used', look: { startEnd: 'none', endEnd: 'arrow', dashed: true } },
  { id: 'aggregation', label: 'Aggregation', reads: 'whole → part', look: { startEnd: 'diamond', endEnd: 'none', dashed: false } },
  { id: 'composition', label: 'Composition', reads: 'whole → part', look: { startEnd: 'filled-diamond', endEnd: 'none', dashed: false } },
];

/** The relation a connector's ends and dash are, as drawn; none for ends of its own. */
export const relationOf = (look: RelationLook): RelationId | undefined =>
  RELATIONS.find((relation) => relation.look.startEnd === look.startEnd && relation.look.endEnd === look.endEnd && relation.look.dashed === look.dashed)?.id;

/**
 * A new connector. A client may pick its `id` (letters, digits and `-`, at most 64), so it can show the connector before
 * the daemon answers. What is left out is the default: a curved line with an arrow at `to`, in the theme's neutral.
 */
export type CreateConnectorParams = { id?: string; from: ConnectorEnd; to: ConnectorEnd; points?: EdgePoint[] } & Partial<ConnectorLook>;

/**
 * A change to a connector's look, label or shape: only the fields given change. Either end can move to another side
 * of its object (`fromSide`, `toSide`), or onto another object (`from`, `to`), whose side a `fromSide` or `toSide`
 * given with it overrides.
 */
export type UpdateConnectorParams = { id: string } & Partial<
  ConnectorLook & Pick<Connector, 'points' | 'from' | 'to'> & { fromSide: ConnectorSide; toSide: ConnectorSide }
>;

/**
 * The side of its tile a flow edge's end is on: one the user picked, or `auto`, picked by the board from where its two
 * tiles are each time it is drawn.
 */
export const FLOW_EDGE_SIDES = [...CONNECTOR_SIDES, 'auto'] as const;
export type FlowEdgeSide = (typeof FLOW_EDGE_SIDES)[number];

/**
 * How a flow edge's line is drawn: the side of each tile it leaves and arrives at, its style, and its bends.
 * An edge given no sides has automatic ones, and is curved.
 */
export interface FlowEdgeShape {
  fromSide: FlowEdgeSide;
  toSide: FlowEdgeSide;
  style: ConnectorStyle;
  points: EdgePoint[];
}
/** The fields of an edge that make up its shape: a change to any of them reshapes it, and leaves its rules be. */
export const FLOW_EDGE_SHAPE_KEYS = ['fromSide', 'toSide', 'style', 'points'] as const satisfies readonly (keyof FlowEdgeShape)[];
export const DEFAULT_FLOW_EDGE_SHAPE = { fromSide: 'auto', toSide: 'auto', style: 'curved', points: [] } as const satisfies FlowEdgeShape;

/**
 * When a flow edge delivers: `auto` as soon as its `from` agent hands off (its turn ends with a final message), or
 * `manual` when the user sends it (`flowEdge.send`).
 */
export const FLOW_EDGE_TRIGGERS = ['auto', 'manual'] as const;
export type FlowEdgeTrigger = (typeof FLOW_EDGE_TRIGGERS)[number];
/**
 * What a flow edge carries from its `from` agent when it hands off: its final message, a markdown file from its
 * worktree (a `handover.md`, a `plan.md`), or a JSON file from its worktree, checked to be JSON.
 */
export const FLOW_EDGE_PAYLOADS = ['final-message', 'handover', 'json'] as const;
export type FlowEdgePayload = (typeof FLOW_EDGE_PAYLOADS)[number];
/** The file a `handover` or `json` edge carries unless told another, relative to its `from` agent's worktree. */
export const DEFAULT_PAYLOAD_PATHS = { handover: 'handover.md', json: 'handoff.json' } as const;

/**
 * Something that must hold before an auto edge delivers. `gate-green`: a gate command (`pnpm check:local`) passes in
 * the `from` agent's worktree, run again only once its head commit moves. `pr-checks`: the checks of the `from`
 * agent's newest pull request pass. `issue-label`: the `from` agent's linked issue has the label. `script`: a command
 * of the user's exits 0 in the `from` agent's worktree.
 */
export type FlowCondition =
  | { kind: 'gate-green'; command: string }
  | { kind: 'pr-checks' }
  | { kind: 'issue-label'; label: string }
  | { kind: 'script'; command: string };
export const FLOW_CONDITION_KINDS = ['gate-green', 'pr-checks', 'issue-label', 'script'] as const satisfies readonly FlowCondition['kind'][];

/** How a condition did the last time it was checked: passed or not, when, and what was seen. */
export interface FlowConditionCheck {
  passed: boolean;
  at: string;
  detail: string;
  /** A gate or script not run because you haven't approved what it runs now (`flowEdge.approve`). */
  needsApproval?: boolean;
}

/**
 * What a gate's or script's command runs, as you approve it: the command, the package.json script it names (as the
 * worktree has it now), and the files inside the worktree they name, by hash (`shown`); and its fingerprint, which
 * changes when any of them does.
 */
export interface FlowCommandPlan {
  command: string;
  shown: string;
  fingerprint: string;
}

/** A gate's or script's command on an edge, and whether you approved it as it is now, or before it changed. */
export interface FlowCommandApproval extends FlowCommandPlan {
  approval: 'approved' | 'unapproved' | 'changed';
  /** The sender session whose worktree it was read in: the one an approval of it is for (`flowEdge.approve`'s `from`). */
  from: string;
}

/**
 * A delivery an edge holds until its conditions pass: since when, the condition that last failed, what it carries,
 * and whether a copy of it is kept (else its file is read again when it is delivered).
 */
export interface FlowHold {
  since: string;
  reason: string;
  name: string;
  copy: boolean;
}

/**
 * What happened along an edge: a payload `delivered` or `skipped` (why), `held` until its conditions pass (which
 * didn't), a held one `released` (and then delivered or skipped), `queued` until its `to` agent's turn ends (why it
 * couldn't take it then), or a gate's or script's command `approved` (which).
 */
export const FLOW_EDGE_EVENT_KINDS = ['delivered', 'skipped', 'held', 'released', 'queued', 'approved'] as const;
export type FlowEdgeEventKind = (typeof FLOW_EDGE_EVENT_KINDS)[number];
export interface FlowEdgeEvent {
  at: string;
  kind: FlowEdgeEventKind;
  /** What it carried, or why it was skipped, held or released. */
  detail: string;
}

/**
 * How a flow edge delivers to a `to` agent that can't take it now (still working, rate-limited, asking you for
 * permission, being typed to): as a `message`, skipped then, or by `queue`, waiting until that agent's turn ends.
 */
export const FLOW_EDGE_DELIVERY_MODES = ['message', 'queue'] as const;
export type FlowEdgeDeliveryMode = (typeof FLOW_EDGE_DELIVERY_MODES)[number];

/**
 * What the user's Send answers: the edge, and whether its payload was only typed at the agent's prompt, no turn having
 * started on it (`Agent.unsent`): recorded as delivered, but not sent.
 */
export type FlowEdgeSent = FlowEdge & { unsent: boolean };

/** How a flow edge's last delivery went: delivered to its `to` agent, or skipped, saying why. */
export interface FlowDelivery {
  at: string;
  delivered: boolean;
  /** Why it was skipped; null when it was delivered. */
  reason: string | null;
}

/**
 * An edge (M2): a directed flow from agent `from` to agent `to` that delivers `from`'s payload to
 * `to` as its next message when `from` hands off, by itself or when the user sends it, once its conditions pass.
 * Unlike a connector it carries something. Deleted with either agent.
 */
export interface FlowEdge extends FlowEdgeShape {
  id: string;
  /** The agents' sessions. */
  from: string;
  to: string;
  trigger: FlowEdgeTrigger;
  payload: FlowEdgePayload;
  /** The file it carries, relative to `from`'s worktree, for a `handover` or `json` payload; else null. */
  path: string | null;
  /** All must pass before an auto hand-off is delivered; Send delivers whatever they say. */
  conditions: FlowCondition[];
  /** Each condition's last check, in order, null before its first. Not kept across a daemon restart. */
  checks: (FlowConditionCheck | null)[];
  /** The hand-off it holds until its conditions pass, or null. */
  held: FlowHold | null;
  deliverAs: FlowEdgeDeliveryMode;
  /** The delivery it keeps until its `to` agent's turn ends: since when, what, and whether a copy is kept; or null. */
  queued: { since: string; name: string; copy: boolean } | null;
  /** Paused, it delivers nothing by itself (auto hand-offs are skipped, a held one waits), but Send still sends. */
  paused: boolean;
  /** Its last delivery, or null before its first. */
  lastDelivery: FlowDelivery | null;
  /** Its latest events, newest first, at most `FLOW_EDGE_HISTORY`. */
  history: FlowEdgeEvent[];
  /** How many times it has delivered, ever. */
  deliveries: number;
  /** Whether it is delivering now: its payload is on its way to `to`. Not kept across a daemon restart. */
  delivering: boolean;
  /** The agent that made it, an orchestrator (`orchestrator.addEdge`); null for one the user drew. */
  madeBy: string | null;
  /**
   * Made by a named hand-off (`board.handoff` with `to`): manual, drawn afterwards to show it, its last payload
   * replayed by Send. Named again, it hands off along it.
   */
  oneOff: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How many of an edge's events it lists. */
export const FLOW_EDGE_HISTORY = 20;

/**
 * A new flow edge: `final-message`, `auto` and no conditions unless given; a file payload's `path` is its default
 * unless given. A client may pick its `id`, as for a connector, and does to make one again on redo.
 */
export interface CreateFlowEdgeParams extends Partial<FlowEdgeShape> {
  id?: string;
  from: string;
  to: string;
  trigger?: FlowEdgeTrigger;
  payload?: FlowEdgePayload;
  path?: string;
  conditions?: FlowCondition[];
  deliverAs?: FlowEdgeDeliveryMode;
  paused?: boolean;
}

/** How many review rounds an implementer may have unless the user says otherwise, and the most they can say. */
export const DEFAULT_REVIEW_CAP = 3;
export const MAX_REVIEW_CAP = 10;

/**
 * Where a review round is: its reviewer at work, its doc `ready`, or `failed` when the reviewer ended without one (it
 * crashed, or was stopped or deleted first).
 */
export type ReviewRoundStatus = 'reviewing' | 'ready' | 'failed';

/**
 * One round of review of an implementer's work: an ephemeral reviewer agent, spawned on a branch from the
 * implementer's, reviews its diff, leaves its review doc as its final message (`review-doc.ts` reads it) and is
 * stopped. The doc is sent to the implementer as its next message when the user says. Rounds are numbered from 1 per
 * implementer, at most its `reviewCap`, and go with it.
 */
export interface ReviewRound {
  id: string;
  /** The implementer's session. */
  implementer: string;
  round: number;
  /** The reviewer agent's session, until it is dismissed or deleted. */
  reviewer: string | null;
  /** The commit its reviewer reviewed: the tip of the implementer's branch when it started. Only it can be merged. */
  head: string | null;
  status: ReviewRoundStatus;
  /** The review doc, markdown, once it is `ready`. */
  doc: string | null;
  /** Why it `failed`. */
  failedBecause: string | null;
  createdAt: string;
  /** When its doc came, or it failed. */
  finishedAt: string | null;
  /** When its doc was last sent to the implementer. */
  sentAt: string | null;
  /** When the user dismissed it: its reviewer went, and its doc stays. */
  dismissedAt: string | null;
}

/**
 * A change to an edge's rules, or its shape: only the fields given change. Changing its payload resets its path unless
 * one is given. A hand-off it holds is dropped when its payload changes or it is made manual; one it queued, when it is
 * made to deliver as a message. Its shape is only how it is drawn, and changes none of that.
 */
export interface UpdateFlowEdgeParams extends Partial<FlowEdgeShape> {
  id: string;
  /**
   * An end moved onto another agent, checked as a new edge between them would be. What it held or queued is dropped:
   * it was handed off by, or to, the agent it left. A new sender drops every approval: its gates and scripts run in the
   * sender's worktree, and nothing approved for one agent applies to another.
   */
  from?: string;
  to?: string;
  trigger?: FlowEdgeTrigger;
  payload?: FlowEdgePayload;
  path?: string;
  conditions?: FlowCondition[];
  deliverAs?: FlowEdgeDeliveryMode;
  paused?: boolean;
}

/**
 * Where a hand-off an edge holds or queues is kept meanwhile: `copy`, its text as it was read (in the database), or
 * `path`, only what it is, its file read again when it is delivered.
 */
export const HELD_PAYLOAD_STORAGE = ['copy', 'path'] as const;
export type HeldPayloadStorage = (typeof HELD_PAYLOAD_STORAGE)[number];

/** The smallest and largest compact window Claude Code accepts for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, in tokens. */
export const COMPACT_WINDOW_RANGE = { min: 100_000, max: 1_000_000 } as const;

/** The settings the daemon keeps and acts on. */
export interface DaemonSettings {
  heldPayloads: HeldPayloadStorage;
  /** The absolute path of the `claude` and `codex` executables, or empty to look for them. */
  claudePath: string;
  codexPath: string;
  /**
   * The context size, in tokens, Claude agents compact at: passed to them as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. 0 (the
   * default) passes nothing, leaving Claude Code's own choice. Codex has no equivalent.
   */
  compactWindow: number;
  /**
   * Whether Claude agents start with `FORCE_HYPERLINK=1`, so the links they print open on ⌘-click as OSC 8 links. On by
   * default. A `FORCE_HYPERLINK` already in the daemon's environment wins either way. Codex and shells never get it.
   */
  clickableLinks: boolean;
  /** What the needs-you inbox lists: explicit requests only (the default), or every finished turn too. */
  needsYouShows: NeedsYouShows;
  /** Whether the app raises an OS notification for each new request in the needs-you inbox. On by default. */
  notifications: boolean;
  /** Whether it does so while the app is in front, too. Off by default: only the pill changes then. */
  notifyInFront: boolean;
  /** The spacing a new zone starts with (`Zone.spacing`). Roomy by default. */
  arrangeSpacing: ArrangeSpacing;
  /**
   * Whether web tabs share one session kept on disk, so their logins, cookies and storage outlast closing the tab and
   * restarting the app, as a browser's do. On by default. Off, each web tab opened afterwards is private: its own session,
   * in memory, forgotten as it closes.
   */
  keepWebLogins: boolean;
  /** The reasoning effort a new agent starts at when it is not asked for one; null (the default) for its harness's own. */
  defaultEffort: Effort | null;
  /**
   * A role's own default reasoning effort, by the role's name (`implementer`, `reviewer`, a custom role's `designer`),
   * over `defaultEffort`. None by default.
   */
  roleEfforts: Record<string, Effort>;
}

/** What an edge would carry if its `from` agent handed off now: its name (`plan.md`) and text, or why it can't. */
export type FlowPayloadPreview = { name: string; text: string; bytes: number } | { name: string; problem: string };

/**
 * What an edge last delivered (`flowEdge.lastPayload`): its name, its text as it was delivered (JSON on one line), and
 * when. Only the daemon's memory keeps it, so a restart forgets it.
 */
export interface FlowDeliveredPayload {
  name: string;
  text: string;
  at: string;
}

/**
 * What an agent hands over its outgoing edges (`board.handoff`). Each edge takes the part that matches what it
 * carries: a final-message edge `message`, a handover edge the file `handoverPath` (relative to the agent's worktree;
 * the edge's own file without), a JSON edge the value `json` (the edge's own file without).
 */
export interface HandoffPayload {
  message?: string;
  handoverPath?: string;
  json?: unknown;
}

/**
 * How a hand-off went along one edge: `delivered` to its `to` agent; `held` until its conditions pass (why); `queued`
 * until that agent's turn ends; `checking`, its conditions still being checked as the call returned (a gate takes
 * minutes); or `skipped` (why), as for a manual or paused edge.
 */
export interface HandoffOutcome {
  edgeId: string;
  to: string;
  outcome: 'delivered' | 'held' | 'queued' | 'checking' | 'skipped';
  /** What it carried: its file's name, or `message`. */
  name: string;
  reason: string | null;
}

/** A new edge an orchestrator makes (`orchestrator.addEdge`): as `CreateFlowEdgeParams`, without an id. */
export type OrchestratorEdgeParams = Omit<CreateFlowEdgeParams, 'id' | 'paused' | keyof FlowEdgeShape>;

/**
 * Where the user put a session's tile: relative to its zone, so it moves with the zone, or a board position for a
 * tile loose on the board. `z` is its stacking order among tiles, higher on top; null for one never brought to
 * the front, which draws under those that were.
 */
export interface TilePosition {
  x: number;
  y: number;
  z: number | null;
}

/** Where to put a tile: `zoneId` null for loose on the board, and `x`, `y` relative to the zone if there is one. */
export interface TileMove {
  zoneId: string | null;
  x: number;
  y: number;
  /** Its new stacking order among tiles; it keeps the one it had without. */
  z?: number;
  /** Puts it in front of every other tile, whatever `z` says. */
  toFront?: boolean;
  /**
   * Saves it only if it has no place yet: the board saving the slot it worked out for a tile with none. A tile placed
   * meanwhile (an orchestrator's arrange) keeps that place.
   */
  ifUnplaced?: boolean;
}

/** The agent CLI a session runs. */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

/**
 * How hard an agent's model thinks before it answers: its reasoning effort, lowest first. Claude Code takes every
 * level (`--effort`, and `/effort` at its prompt); Codex all but `max` (`model_reasoning_effort`).
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** When an agent takes a reasoning effort it is set to (`agent.setEffort`): now, once its turn ends, or when next started. */
export type EffortApplies = 'now' | 'after-turn' | 'restart';
export type EffortPending = Exclude<EffortApplies, 'now'>;

/** The reasoning efforts each harness takes. */
export const HARNESS_EFFORTS: Record<Harness, readonly Effort[]> = { claude: EFFORTS, codex: ['low', 'medium', 'high', 'xhigh'] };

/** Why the `harness` agent can't run at `effort`, or undefined when it can. */
export function effortRefusal(harness: Harness, effort: unknown): string | undefined {
  const takes = HARNESS_EFFORTS[harness];
  if (takes.includes(effort as Effort)) return undefined;
  return `${harness === 'claude' ? 'Claude' : 'Codex'} takes a reasoning effort of ${takes.slice(0, -1).join(', ')} or ${takes.at(-1)}`;
}

/** A session as clients see it. Shell sessions have no harness. */
export interface SessionInfo {
  id: string;
  harness: Harness | null;
  cwd: string;
  /** The session's process; gone once `endedAt` is set. */
  pid: number;
  cols: number;
  rows: number;
  createdAt: string;
  /** When the process ended; null while it runs. */
  endedAt: string | null;
  /** Null while running, or when it was ended by a signal. */
  exitCode: number | null;
  /**
   * Whether it ended because its daemon went away (a crash, a shutdown, the machine restarting), not because it exited
   * or the user stopped it. The app offers to resume such a session.
   */
  stoppedByRestart: boolean;
}

/**
 * What a session is doing, from its harness's hooks (ADR-0004): the state of a subagent or an external session, and
 * the state an agent's hooks put it in. `waiting` and `needs-permission` put an agent in the needs-you inbox. `done`
 * means its session ended; `failed` that its process crashed or was killed, or that a turn failed (`StopFailure`),
 * after which a live agent moves on with its next prompt.
 */
export const SESSION_STATES = [
  'running',
  'thinking',
  'waiting',
  'needs-permission',
  'idle',
  'rate-limited',
  'failed',
  'done',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * What an agent is doing: its session's state, or `scheduled` for a live agent with an enabled schedule that sits at
 * its prompt waiting for its next run, not for you, or `stopped-by-restart` for an ended agent whose session ended
 * because its daemon went away (a crash, a shutdown, the machine restarting), until it is resumed (`agent.resume`).
 * An agent with an enabled schedule is `stopped-by-restart` too: its clock may not fire for days, though it relaunches
 * one still stopped when it does. `handing-off` is a live agent delivering its payload along its flow edges, whatever
 * its hooks say, until every delivery has landed.
 * `starting` is a live agent started with a first prompt whose session has sent no hook yet: its turn has not begun, so
 * it is neither `idle` (it would take a message) nor mid-turn. `on-command` is a live agent at its prompt, asking
 * nothing, while a command it left running in the background still runs (`Agent.commands`): its work goes on, so it
 * neither looks finished nor waits for you. `hibernated` is an ended agent someone paused (`Agent.hibernated`) to free
 * what its harness held, until it is woken: by `agent.resume`, a message, a hand-off or a scheduled run, each of which
 * carries on its conversation. It wins over `scheduled` and `stopped-by-restart`.
 */
export const AGENT_STATES = [...SESSION_STATES, 'scheduled', 'stopped-by-restart', 'handing-off', 'starting', 'on-command', 'hibernated'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** The states a live agent may be paused in: between turns, at its prompt. */
const PAUSABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'waiting', 'failed', 'scheduled']);

/**
 * Why the agent can't be paused (hibernated) now, or undefined if it can: only a live agent between turns, asking the
 * user nothing, pauses. The daemon checks its prompt too (the user typing there, a message never sent).
 */
export function pauseRefusal(agent: Pick<Agent, 'endedAt' | 'state' | 'ask' | 'plan' | 'permissions'>): string | undefined {
  if (agent.state === 'hibernated') return 'it is already paused';
  if (agent.endedAt !== null) return 'it has ended';
  if (agent.state === 'needs-permission' || agent.permissions.length > 0 || waitsOnUser(agent) || planPending(agent)) return 'it is waiting on you';
  if (agent.state === 'rate-limited') return 'it is rate-limited';
  // A pause would end the command with its session.
  if (agent.state === 'on-command') return 'a command it left running still runs';
  if (!PAUSABLE_STATES.has(agent.state)) return 'it is mid-turn: finish its turn first';
  return undefined;
}

/** States an agent is mid-turn in, which `agent.interrupt` accepts; as does an agent waiting on the user mid-call (`isMidTurn`). */
export const INTERRUPTIBLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'needs-permission']);

/** Whether the agent is mid-turn, which `agent.interrupt` takes: working, or with its call waiting on the user. */
export function isMidTurn(agent: Pick<Agent, 'state' | 'ask' | 'plan'>): boolean {
  return INTERRUPTIBLE_STATES.has(agent.state) || waitsOnUser(agent);
}

/**
 * Whether the agent can continue on credits now (`agent.continueOnCredits`): a live Claude agent its usage limit stopped,
 * Claude's rate-limit screen up. Never offered otherwise, and never done by itself.
 */
export function continuesOnCredits(agent: Pick<Agent, 'harness' | 'state' | 'endedAt'>): boolean {
  return agent.harness === 'claude' && agent.state === 'rate-limited' && agent.endedAt === null;
}

/**
 * What reaches the needs-you inbox (`DaemonSettings.needsYouShows`): `explicit`, only what an agent asks for (a
 * permission prompt, a question or plan, or a flag); `turns` also every agent waiting at its prompt, its turn ended.
 */
export const NEEDS_YOU_SHOWS = ['explicit', 'turns'] as const;
export type NeedsYouShows = (typeof NEEDS_YOU_SHOWS)[number];

/**
 * Why an agent is in the needs-you inbox, the first that holds: a permission prompt, a question, a plan to review, a
 * flag to the user (`Agent.flag`), or (with `turns`) its turn ended at its prompt.
 */
export type NeedsYouKind = 'permission' | 'asks' | 'plan' | 'steps' | 'todo' | 'flagged' | 'turn';

/**
 * A steps card an agent waits on the user for: `steps`, a set it made of questions the user answers, not yet sent; or
 * `todo`, a to-do of the user's it waits on. Enough for a Needs-you row without reading the card.
 */
export interface AgentStepsWait {
  kind: 'steps' | 'todo';
  /** The steps card. */
  itemId: string;
  title: string;
  /** The step that matters: its first unanswered question (else its first question), or the to-do. */
  stepId: string;
  text: string;
  /** How many of its questions are still unanswered; 0 for a to-do. */
  open: number;
  /** When the card was put up: the row's age. */
  since: string;
}

/**
 * Whether an agent is free to be handed a job: live, its turn ended at its prompt, and asking the user nothing (no
 * permission prompt, question or plan waiting). A working agent takes no hand-on.
 */
export function takesHandOn(agent: Pick<Agent, 'endedAt' | 'state' | 'permissions' | 'ask' | 'plan'>): boolean {
  return agent.endedAt === null && (agent.state === 'idle' || agent.state === 'waiting') && agent.permissions.length === 0 && agent.ask === null && !planPending(agent);
}

/** The agent fields the needs-you rule reads. */
export type NeedsYouFacts = Pick<Agent, 'endedAt' | 'state' | 'permissions' | 'ask' | 'plan' | 'stepsWait' | 'flag' | 'ledBy'>;

/** Why the agent is in the needs-you inbox under `shows` (an ended one only for its flag), or null if it isn't. */
export function needsYouKind(agent: NeedsYouFacts, shows: NeedsYouShows): NeedsYouKind | null {
  // Only a flag that outlives its session (what was never delivered to it) keeps an ended agent here.
  if (agent.endedAt !== null) return agent.flag?.to === 'user' ? 'flagged' : null;
  // A question tool's prompt asks questions, not a permission: it is the agent asking.
  if (agent.state === 'needs-permission' || permissionPrompt(agent) !== undefined) return 'permission';
  if (agent.ask !== null || questionPrompt(agent) !== undefined) return 'asks';
  if (planPending(agent)) return 'plan';
  // A steps card it waits on: its set to answer, or a to-do of the user's (none on a record that predates them).
  const card = agent.stepsWait?.kind;
  if (card !== undefined) return card;
  if (agent.flag?.to === 'user') return 'flagged';
  // A crew member's finished turn is its live orchestrator's to handle, not the user's.
  return shows === 'turns' && agent.state === 'waiting' && agent.ledBy === null ? 'turn' : null;
}

/**
 * Whether an agent waits for the user (`needsYouKind`): the app's needs-you inbox holds these, and the daemon's start
 * banner counts them. A crew member's flag, and its finished turns, go to its live orchestrator, so never count here.
 */
export function waitsForYou(agent: NeedsYouFacts, shows: NeedsYouShows): boolean {
  return needsYouKind(agent, shows) !== null;
}

/**
 * Whether an agent that waits for the user still needs them now: it has not been seen since it began asking, or it
 * flags them (opening its session clears a flag, so one still standing is unread). It counts, and shows needs-you.
 */
export function needsYouNow(agent: NeedsYouFacts & Pick<Agent, 'seen'>, shows: NeedsYouShows): boolean {
  if (agent.flag?.to === 'user') return true;
  return needsYouKind(agent, shows) !== null && !agent.seen;
}

/**
 * What interrupting a turn types: Ctrl-C, which both TUIs take as "interrupt the turn" (as they do Esc). At their
 * prompt, a second one soon after quits, so agents are only sent it mid-turn.
 */
export const INTERRUPT_KEY = '\x03';

/**
 * An agent: a session running a harness in its own worktree, drawn as a tile in any zone or loose on the board. Where
 * its tile sits is only where it is drawn: its repo, worktree, branch and linked issue stay its own.
 */
export interface Agent {
  /** The agent's session. */
  sessionId: string;
  /** The zone its tile sits in, or null for loose on the board. */
  zoneId: string | null;
  /** Where its tile is, in its zone or on the board; null until it has a place, when the board slots it in. */
  position: TilePosition | null;
  /**
   * The repo its worktree and branch were made in: the one it was started from, or its zone's. For an external session
   * resumed in its own folder, that folder's repo, or the folder itself outside git (with `branch` '').
   */
  repoRoot: string;
  harness: Harness;
  /** The model it was started with, or null for its harness's default. */
  model: string | null;
  /**
   * Its reasoning effort (`Effort`), or null for its harness's own: what it was started with, or last set to
   * (`agent.setEffort`), which a restart starts it with.
   */
  effort: Effort | null;
  /**
   * When a live agent takes the `effort` it was last set to, if not yet: once its turn ends (`after-turn`, typed at its
   * prompt then), or only when it is next started (`restart`: its harness can't change it live). Null once it has it.
   */
  effortPending: EffortPending | null;
  /** The role it was started in, or null for none. */
  role: AgentRole | null;
  /** A custom role's name, as `parseRole` read it: `designer`. Null for any other role, or a custom one unnamed. */
  roleName: string | null;
  /**
   * For an agent started as a reviewer or follow-up reviewer: the branch it reviews and the commit it checked
   * out, detached, in a worktree of its own (its `branch` is then ''). Null for any other agent.
   */
  reviews: ReviewedBranch | null;
  name: string;
  /**
   * What it is working on: the task it was started with. For an agent started from an issue, the typed task, else the
   * issue's description.
   */
  description: string;
  /**
   * The branch its worktree is on now, for its tile, pull request lookup and `--base`: '' for an external
   * session resumed outside git, or on a detached HEAD, in its own folder. After a checkout of another branch it is that
   * one; while HEAD is detached, the last branch it was on (see `detached`).
   */
  branch: string;
  /** The branch it owns: what closing it checks for unsaved work and deletes, and a pull request is opened from. A rename moves it; a checkout does not. */
  ownedBranch: string;
  /** Its worktree's HEAD is detached: `branch` is the last branch it was on. */
  detached: boolean;
  /**
   * Absolute path of its git worktree (ADR-0007); for an external session resumed in its own folder, that folder's
   * worktree, or the folder itself outside git (`ownsWorktree` false).
   */
  worktree: string;
  /** Where its harness started: the worktree, or the zone's folder inside it. */
  cwd: string;
  state: AgentState;
  /** What the user should know about how it ran, e.g. why agent-board stopped it; null when there is nothing. */
  notice: string | null;
  /**
   * Its daemon went away under it mid-turn, and no turn has begun since: resuming it in its conversation types the
   * continue line. Absent from an older daemon.
   */
  cutOffMidTurn?: boolean;
  /**
   * When it was paused (`agent.pause`, `orchestrator.pause`) and by whom: the orchestrator's name as it is now and its
   * session id, or both null for the user.
   * Set while it is `hibernated`; null once it wakes or is closed, and for an agent never paused.
   */
  hibernated: { at: string; by: string | null; byId: string | null } | null;
  /** The conversations it had before a fresh restart started a new one in its tile, oldest first; their transcripts stay on disk. */
  earlierConversations: EarlierConversation[];
  /** The tracker issue it works on, or null. */
  issue: LinkedIssue | null;
  /**
   * What it says it is doing now, set from its own session (`agent-board status set`, ADR-0010); null until it sets
   * one, when its tile shows its `description`.
   */
  status: AgentStatus | null;
  /** The pose it set for its character, while it lasts; null for none, when the board draws its own. */
  character: AgentCharacter | null;
  /**
   * The work category it set for itself (`board.setStatus` with `category`, ADR-0024), or its orchestrator set for it:
   * what kind of wait its work is in. Null until one is set, and once cleared, when the board guesses (`workCategory`).
   */
  workCategory: AgentWorkCategory | null;
  /**
   * When it said its work is finished: it handed off (`board.handoff`) or set its status as done
   * (`board.setStatus` with `done`). A turn ending is not finishing: an agent may end turns while its background work
   * runs. Null until then, and again from its next prompt.
   */
  workFinishedAt: string | null;
  /** Whether the user muted its OS notifications. It still counts in the needs-you inbox. */
  muted: boolean;
  /**
   * Whether the user has opened its session since it last began asking (`agent.markSeen`): its current ask is read, so it
   * stops counting towards the badge, the dock and the menu bar, and its tile drops the needs-you look. The next time it
   * works, or a new permission prompt comes, it is cleared and the agent needs the user again.
   */
  seen: boolean;
  /**
   * The GitHub pull requests made from its branch, newest first, with their state and checks: as last seen by the
   * daemon, which asks gh every minute or so. Empty when the repo is not on GitHub.
   */
  pullRequests: PullRequest[];
  /**
   * When none of `pullRequests`, the pull requests its work went into on other branches: those of the
   * branches it pushed its own commits to (its upstream among them), else the one holding its newest pushed commit. For
   * its tile alone: they are not its own, so nothing merges, gates or cleans them up from it.
   */
  pushedPullRequests: PullRequest[];
  /** The pull requests it recorded (`records`) that are neither of those, as gh last saw them: for its sidebar alone. */
  recordedPullRequests: PullRequest[];
  createdAt: string;
  /** Set once its process has ended. */
  endedAt: string | null;
  /** How its process exited, once it has: null while it runs, or when a signal ended it. */
  exitCode: number | null;
  /**
   * Once it has ended, the login shell its pane dropped into, in its folder, while that shell runs: the session its
   * terminal shows instead of its own. Null otherwise.
   */
  shellSessionId: string | null;
  /** Its own harness, while the user runs it by hand in the shell its pane dropped into (the tile shows it, and Restart waits). */
  shellHarness: Harness | null;
  /**
   * For a Claude agent the daemon started: whether that session got `FORCE_HYPERLINK=1` from the clickable links setting,
   * so Settings can offer a restart to those started the other way. Null for Codex, and for a session this daemon did
   * not start (an external one, or one that outlived the daemon).
   */
  clickableLinks: boolean | null;
  /** The subagents it has spawned that are still running, or finished a moment ago; oldest first. */
  subagents: Subagent[];
  /**
   * The commands it left running in the background that still run, longest-running first, while it is `on-command`;
   * empty otherwise.
   */
  commands: BackgroundCommand[];
  /**
   * What it last said to the user, the context for answering it: its final message from the turn it last finished
   * (`Stop`), or the message of a mid-turn request for input. Null before then, and from each new prompt until then.
   */
  lastMessage: string | null;
  /**
   * Since when it has been compacting its conversation (its harness's `PreCompact` hook, until `PostCompact`, its turn
   * ending or its next prompt); null while it isn't.
   */
  compactingSince: string | null;
  /**
   * When its shown `state` began, timed by the daemon as it reads the agent. A hand-off is timed as part of the state it
   * came from, so it never restarts the time. After a daemon restart, a paused or ended agent keeps its row's time; any
   * other starts at the restart.
   */
  stateSince: string;
  /**
   * When its own turn last ended with a final message (`Stop`), kept across a new prompt and a daemon restart; null
   * before its first. A manual edge out of it has something new to send once this is after its last delivery.
   */
  finishedAt: string | null;
  /**
   * The tool calls, its own or its subagents', waiting for the user's permission, oldest first. While any is, the
   * agent is `needs-permission`.
   */
  permissions: PermissionPrompt[];
  /**
   * The question it asks the user through the board (`board.ask`) and waits on, mid-turn; null while it asks
   * none. While it asks, it is `waiting`.
   */
  ask: AgentAsk | null;
  /**
   * A steps card it waits on the user for, between turns (Needs you): its set of questions not yet sent, or a to-do of
   * the user's it waits on (`steps wait`). Null while it waits on none, and always for an ended agent.
   */
  stepsWait: AgentStepsWait | null;
  /**
   * Its latest plan (`board.presentPlan`): v1, v2… with its decision once the user has made one. While that is
   * still to make, it waits on it and is `waiting`. Null before its first; `plan.list` has them all, with their bodies.
   */
  plan: PlanSummary | null;
  /** The documents it has shown the user (`board.showDoc`), first shown first. */
  docs: DocumentSummary[];
  /** Its cron schedule, which makes it a long-lived agent; null for none. */
  schedule: AgentSchedule | null;
  /** For a reviewer, the agent whose work it reviews, its implementer; null for any other agent. */
  reviewOf: string | null;
  /** How many review rounds it may have: `DEFAULT_REVIEW_CAP` unless the user set it (`review.setCap`). */
  reviewCap: number;
  /**
   * Whether agent-board made its worktree and branch, which deleting it removes. False for an external session resumed
   * in its own folder (`external.resume`): deleting it only takes it off the board.
   */
  ownsWorktree: boolean;
  /** Whether it is the Captain (ADR-0019): the one agent the user asks for work, at most one per board. */
  master: boolean;
  /**
   * Whether it runs in its group's own folder (`Zone.groupFolder`), outside git: it has no worktree or branch, and the
   * app runs no git there (no branch reads, gate, pull requests or checkout warning). Deleting it leaves the folder,
   * which the group's other agents with no repo share. Kept as it was started, so it stays one if the folder is made a
   * git repo later.
   */
  plainFolder: boolean;
  /**
   * Whether it may start, message and watch other agents through the board CLI and MCP, and where: its scope,
   * or null while it may not. Only the user sets it (`agent.setOrchestrate`); an agent an orchestrator starts never has it.
   */
  orchestrate: OrchestrateScope | null;
  /** The orchestrator that started it, or null for an agent the user started (or once that orchestrator is deleted). */
  spawnedBy: string | null;
  /**
   * The name of the orchestrator that started it while that one is live, else null (a loose agent, or one whose
   * orchestrator has ended). Its turns, questions and open changes go to that orchestrator, not the user.
   */
  ledBy: string | null;
  /** What it flagged for attention (`board.needsYou`) and hasn't cleared; null for none. */
  flag: AgentFlag | null;
  /**
   * What it recorded about its own work (`board.record`), for its sidebar: the pull requests it opened, its hand-off
   * docs (and those its crew recorded for it), and the agents it started; oldest first. Deleted ones stay, with
   * `deletedAt`, so what gh or hooks guess of the same entry stays hidden too.
   */
  records: AgentRecord[];
  /** The page it wrote for its sidebar (`board.setPage`); null until it writes one, or once it clears it. */
  page: AgentPage | null;
  /** Its worktree's `.agent-board/handover.md`, absolute, while that file is there: a hand-off doc guessed, not recorded; else null. */
  guessedDoc: string | null;
  /**
   * What was typed at its prompt and never sent, or null: a hand-off, a scheduled run or a message the board typed
   * there, whose Enter, pressed again, started no turn (`Hand-off from impl`). Nothing more is typed at it until it is
   * sent (`agent.sendUnsent`) or cleared (`agent.clearUnsent`), a hook of its turn says it was taken, Enter, Ctrl-C or
   * Ctrl-U is typed in its terminal, or its session ends.
   */
  unsent: string | null;
  /**
   * Its first prompt, typed at its prompt only once its session is up (its `SessionStart`), while its session has
   * been given up on saying so: still `starting` past its limits, or relaunched a minute ago with no `SessionStart`.
   * Nothing is typed at it blind, as Enter on a startup screen would answer it; the tile offers it to send
   * (`agent.typeFirstPrompt`), and the agent is flagged (`flag`), unless it flags something of its own, until it is
   * typed or the user opens the agent. Null otherwise, while Claude's trust screen is up (`trustFolder`), and once
   * its `SessionStart` comes (not one after a compaction: it is typed then), its prompt shows on its screen (it is
   * typed then too), or its session ends.
   */
  untypedPrompt: string | null;
  /**
   * The folder Claude's trust screen asks about, while the live Claude agent's first prompt waits on it: Claude shows
   * it in a folder it has never opened, and fires no `SessionStart` until it is answered. The flag says so to the user,
   * never an orchestrator; `agent.trustFolder` answers it as the user asks, and the first prompt is typed once the
   * session is up. Nothing is typed there otherwise, as Enter picks `No, exit`. Null otherwise.
   */
  trustFolder: string | null;
  /**
   * Whether its zone's setting (`Zone.trustsFolder`) answered Claude's trust screen for it, in place of the user: its
   * tile says "trusted by this zone's setting". Kept once answered.
   */
  trustedByZone: boolean;
  /** How many messages sent before the live agent's session was up wait to be typed, after its first prompt. */
  queuedUntilUp: number;
  /**
   * How many messages other agents sent the live orchestrator mid-turn wait for a turn of its to end, to be typed one
   * after another, each a turn of its own (`queued-after-turn`).
   */
  messagesWaiting: number;
  /**
   * What was sent to the agent before its session was up and never typed, oldest first: its session ended first, its
   * first prompt was left unsent, or a question or permission prompt was up when its turn came. Its sender heard it was
   * queued, so it is kept, and flagged to the user (a flag that outlives its session), until the user resends it
   * (`agent.resendUndelivered`) or clears it (`agent.clearUndelivered`). A hand-off goes back to its edge instead.
   */
  undelivered: UndeliveredMessage[];
  /**
   * Its harness starting: while it is `starting`, and kept once it ended before its session's first hook (it never
   * came up). Null otherwise.
   */
  startup: AgentStartup | null;
  /**
   * The live agent stopped showing `starting` before its session sent any hook (hooks off, not installed, or unable to
   * reach the daemon), and none has come since: the board can't follow its turns, so its state, needs-you and hand-offs
   * don't work. Its tile says so. Cleared by its first hook.
   */
  hooksSilent: boolean;
}

/** Something sent to an agent before its session was up and never typed (`Agent.undelivered`). */
export interface UndeliveredMessage {
  /** What it was: `A message`, `A scheduled run`. */
  what: string;
  text: string;
  /** Why it wasn't typed. */
  reason: string;
}

/** An agent's harness starting, as its tile shows it (`Agent.startup`). */
export interface AgentStartup {
  /** The last line its terminal showed, or null before it showed any. */
  output: string | null;
  /** It ended before its session's first hook: its start failed, and Restart retries it in the same worktree. */
  failed: boolean;
}

/** What starting an agent does before its session runs, in order (`AgentStart`). */
export const START_STEP_KINDS = ['issue', 'worktree', 'launch'] as const;
export type StartStepKind = (typeof START_STEP_KINDS)[number];

/** One step of starting an agent: done, under way, or what it failed at. */
export interface StartStep {
  kind: StartStepKind;
  state: 'done' | 'now' | 'failed';
  /** What it made, once done: the issue's short id, or the new worktree's branch (its folder, with no branch). */
  detail: string | null;
}

/**
 * An agent being started, before it is an agent (`agent.starts`): its tile is on the board from the moment it is asked
 * for, showing each step as it happens, and turns into the agent's own, under the same session id, once its session
 * runs. One that failed stays with its error, for Retry (`agent.retryStart`) or Delete (`agent.dismissStart`); what
 * it made before it failed is undone. Kept in the daemon's memory only.
 */
export interface AgentStart {
  /** The session id its agent will have. */
  sessionId: string;
  zoneId: string | null;
  /** Where its tile was put, relative to its zone; null to be laid out there. */
  position: { x: number; y: number } | null;
  name: string;
  harness: Harness;
  model: string | null;
  effort: Effort | null;
  /** The orchestrator starting it, whose crew its tile sits in; null for the user's. */
  spawnedBy: string | null;
  steps: StartStep[];
  /** Why it failed, or null while it is still going. */
  error: string | null;
  /**
   * The error is the warning a Codex agent's worktree has Codex config of its own (`AGENT_ERROR.projectCodexConfig`):
   * a retry must confirm it (`allowProjectCodexConfig`).
   */
  confirm: boolean;
}

/**
 * An agent's "please look" (`board.needsYou`): no question, nothing held. It goes to the agent's orchestrator while
 * that one is live, else to the user, in the needs-you inbox. The agent clears it, or the user by opening its session;
 * its orchestrator by sending it a message. Its session ending clears it. Kept in memory only.
 */
export interface AgentFlag {
  /** Names this flag: a new one, even with the same reason, has a new id. */
  id: number;
  /** Why, in the agent's words: one line, at most `MAX_FLAG_LENGTH`. */
  reason: string;
  at: string;
  /** Who it reaches: the user, or the live orchestrator that started the agent. */
  to: 'user' | 'orchestrator';
  /** For an orchestrator's flag, the crew member it passes on, by name; else null. */
  via: string | null;
}

/** Longest reason a flag takes. */
export const MAX_FLAG_LENGTH = 300;

/**
 * What `board.ask` and `board.presentPlan` answer a crew member whose orchestrator is live: its question or plan went to
 * that orchestrator as its flag, and nothing waits. The orchestrator answers with its next message.
 */
export interface SentToOrchestrator {
  sentTo: 'orchestrator';
  /** The orchestrator's name. */
  name: string;
}

/** Where in its worktree a crew member's question too long for a flag is written in full, with its options, for its orchestrator to read. */
export const CREW_QUESTION_PATH = '.agent-board/question-for-review.md';

/** Where in its worktree a crew member's plan is written for its orchestrator to read, by format. */
export const CREW_PLAN_PATH: Record<PlanFormat, string> = { markdown: '.agent-board/plan-for-review.md', html: '.agent-board/plan-for-review.html' };

/** The branch a reviewer reviews, and the commit of it its detached checkout is at. */
export interface ReviewedBranch {
  branch: string;
  head: string;
}

/**
 * A long-lived agent's cron schedule: the clock joined to it that messages it (`ClockData`), the soonest of them if it
 * has more. At each fire time the daemon starts a run: it sends `prompt` to the agent as its next message, relaunching
 * the agent first if its session has ended. A fire time at which the agent is still working, rate-limited, waiting for
 * you, or has a draft typed at its prompt, is skipped. One after a failed turn runs.
 */
export interface AgentSchedule {
  /** The clock's board item id. */
  clockId: string;
  /** Five fields (minute, hour, day of month, month, day of week) or a macro such as `@daily`, in the daemon's local time. */
  cron: string;
  prompt: string;
  enabled: boolean;
  /** When it next fires; null while disabled. */
  nextRunAt: string | null;
  /** The last time it fired, or null if it hasn't yet. */
  lastRun: ScheduleRun | null;
  /** Whether the clock pauses the agent once each run's turn ends (`ClockData.hibernate`), until its next run wakes it. */
  hibernates: boolean;
}

/** A schedule as the user sets it. */
export interface ScheduleSpec {
  cron: string;
  prompt: string;
  /** True by default. */
  enabled?: boolean;
}

/**
 * How a clock's run went: `started` (its message was sent), `skipped` (`reason` says why), `running` (its fresh agent
 * is at work), `done` (its fresh agent finished) or `failed`.
 */
export const CLOCK_RUN_OUTCOMES = ['started', 'skipped', 'running', 'done', 'failed'] as const;
export type ClockRunOutcome = (typeof CLOCK_RUN_OUTCOMES)[number];

/** One time a schedule fired: the run it started, or why it skipped. */
export interface ScheduleRun {
  /** The fire time it was due at. */
  dueAt: string;
  /** When it went off: later than `dueAt` if the machine slept through it. */
  firedAt: string;
  outcome: ClockRunOutcome;
  /** Why it skipped or failed, e.g. `it was still running`; null otherwise. */
  reason: string | null;
}

/** What a clock does when it fires: messages the agent it is joined to, or starts a fresh agent for the run. */
export const CLOCK_ACTIONS = ['message', 'fresh'] as const;
export type ClockAction = (typeof CLOCK_ACTIONS)[number];

/**
 * What a clock does with its agent once a run's turn has ended: `hibernate` pauses it (its conversation kept, so the
 * next run carries on from what it has seen), `close` gives every run a fresh agent and closes it (a `fresh` clock),
 * and `idle` leaves it at its prompt (a `message` clock that doesn't hibernate).
 */
export const CLOCK_MODES = ['hibernate', 'close', 'idle'] as const;
export type ClockMode = (typeof CLOCK_MODES)[number];

/** A clock's mode, from what it does and whether it hibernates its agent: a clock made before modes doesn't. */
export function clockMode(data: Pick<ClockData, 'does' | 'hibernate'>): ClockMode {
  if (data.does === 'fresh') return 'close';
  return data.hibernate === true ? 'hibernate' : 'idle';
}

/** The fields of a clock's data that set `mode`. */
export function withClockMode(mode: ClockMode): Pick<ClockData, 'does' | 'hibernate'> {
  return { does: mode === 'close' ? 'fresh' : 'message', hibernate: mode === 'hibernate' };
}

/**
 * Where a fresh agent's result goes: the clock's run history alone, the history and an agent note where its tile was,
 * or the history and a hand-off to another agent (`handoffTo`).
 */
export const CLOCK_RESULTS = ['history', 'note', 'handoff'] as const;
export type ClockResult = (typeof CLOCK_RESULTS)[number];

/** How a clock starts a fresh agent: its harness, model and role (null for the defaults). */
export interface ClockFreshAgent {
  harness: Harness;
  model: string | null;
  role: string | null;
  /** Whether the agent is removed once its run finishes. */
  closeWhenDone: boolean;
}

/** Whether `fresh` is how a fresh agent starts: a clock's, or a queue's drain's. */
export function isFreshAgent(fresh: unknown): fresh is ClockFreshAgent {
  if (typeof fresh !== 'object' || fresh === null) return false;
  const f = fresh as Record<string, unknown>;
  return (
    (HARNESSES as readonly unknown[]).includes(f.harness) &&
    (f.model === null || typeof f.model === 'string') &&
    (f.role === null || typeof f.role === 'string') &&
    typeof f.closeWhenDone === 'boolean'
  );
}

/**
 * A clock's `data`: a schedule on the board. It fires on `cron` while `enabled`, and either messages `agent` with
 * `prompt`, or starts a fresh agent in its own zone with `prompt` as its task, waits for its turn to end, routes its
 * final message by `result`, and closes it. A clock that can't fire (no agent, no zone for a fresh one, no prompt) is
 * not set, and never planned.
 */
export interface ClockData {
  cron: string;
  enabled: boolean;
  does: ClockAction;
  /** The agent it messages (`message`); null while unjoined. */
  agent: string | null;
  /**
   * Whether a `message` clock pauses its agent once each run's turn has ended (`clockMode` `hibernate`). Missing on a
   * clock made before it, which doesn't.
   */
  hibernate?: boolean;
  /** What it sends the agent, or a fresh agent's task. */
  prompt: string;
  fresh: ClockFreshAgent;
  result: ClockResult;
  /** The agent a fresh agent's result is handed to (`result` `handoff`). */
  handoffTo: string | null;
  /** Whether it is drawn folded to a pill. */
  folded: boolean;
  /**
   * Whether an unjoined `message` clock starts its own agent on its first fire, as a fresh one starts (`fresh`'s
   * harness, model and role, under the clock, named from its task), then joins it. Missing on a clock made before it.
   */
  startsAgent?: boolean;
  /** The agent that last set its mode (`clock.self`), and why; the user setting the mode clears it. */
  modeSetBy?: ClockMark | null;
  /** The agent that turned it off (`clock.self`), and why; the user turning it on again clears it. */
  stoppedBy?: ClockMark | null;
}

/** An agent's change to its own clock, as the clock's data keeps it. */
export interface ClockMark {
  sessionId: string;
  /** The agent's name, as it was. */
  name: string;
  why: string;
  at: string;
}

/** The longest reason an agent gives for changing its own clock. */
export const MAX_CLOCK_WHY = 200;

/** One change an agent made to its own clock (`clock.self`), newest first in its status. */
export interface ClockChange {
  id: number;
  /** The run it was made in, if one of the clock's runs was going for that agent. */
  runId: number | null;
  at: string;
  sessionId: string;
  agentName: string;
  /** `mode`: set to `value` (a `ClockMode`); `stop`: turned off. */
  change: 'mode' | 'stop';
  value: string | null;
  why: string;
}

/** What `clock.self` changes on the caller's own clock: its mode, or turns it off. */
export interface ClockSelfParams {
  token?: string;
  /** The clock, for an agent with more than one. */
  clock?: string;
  after?: ClockMode;
  stop?: boolean;
  why: string;
}

/**
 * The part of a clock a saved template keeps, to start new clocks from: what it does and when, never which agent it
 * messages, where a hand-off goes, whether it is on, or how it is drawn.
 */
export type ClockTemplateData = Pick<ClockData, 'cron' | 'prompt' | 'does' | 'fresh' | 'result'> & Pick<Partial<ClockData>, 'hibernate' | 'startsAgent'>;
/** The data keys a template keeps. */
export const CLOCK_TEMPLATE_KEYS = ['cron', 'prompt', 'does', 'hibernate', 'startsAgent', 'fresh', 'result'] as const satisfies readonly (keyof ClockTemplateData)[];
/** The most characters of a template's name. */
export const MAX_CLOCK_TEMPLATE_NAME = 60;
/** The most templates one agent saves, and the most there are in all. */
export const MAX_CLOCK_TEMPLATES_PER_AGENT = 50;
export const MAX_CLOCK_TEMPLATES = 200;

/** A clock saved under a name to start new ones from (ADR-0017), kept by the daemon for every zone. */
export interface ClockTemplate {
  id: string;
  /** Unique, whatever its case. */
  name: string;
  data: ClockTemplateData;
  /** The agent that saved it, by session id; null for the user's. Only it, or the user, removes it. */
  madeBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClockTemplateSaveParams {
  token?: string;
  name: string;
  /** Its data, filled in from a new clock's; or `fromClock` to save that clock's. */
  data?: Partial<ClockTemplateData>;
  fromClock?: string;
}

/** A clock's size as a card, and folded to a pill. */
export const CLOCK_SIZE = { width: 256, height: 76 };
export const CLOCK_FOLDED_SIZE = { width: 200, height: 34 };

/** How many of a clock's runs its status carries, newest first. */
export const CLOCK_RUNS_KEPT = 20;

/** One time a clock fired. */
export interface ClockRun extends ScheduleRun {
  id: number;
  /** The agent the run messaged or started; null when it skipped before that. */
  sessionId: string | null;
  /** That agent's name, as it was: a fresh one is gone once its run is over. */
  agentName: string | null;
  /** When the run finished or failed: a fresh agent's, or one that waits for the turn it sent (`awaitsTurn`). */
  finishedAt: string | null;
  /** The final message of the run's turn: a fresh agent's, or the turn a message started. */
  result: string | null;
  /**
   * Whether the run's message started a turn that the run waits to end, as a fresh agent's run does: it is going on while
   * `finishedAt` is null. Its outcome stays `started`, so an older daemon, which settles only `running` runs, leaves it.
   */
  awaitsTurn: boolean;
  /** The reason the run's agent flagged you for a look (`needs_you`) while the run went on; null for a quiet run. */
  flag: string | null;
}

/** The skips a clock's latest runs are, one after another since its last run that was not a skip: how many, since when, and why. */
export interface ClockSkips {
  count: number;
  /** When the first of them fired. */
  since: string;
  /** Each reason they skipped for, once, the latest first. */
  reasons: string[];
}

/**
 * How many skips in a row, because its agent was still working (or, between those, waiting for you), make a clock that
 * messages it flag the agent: its turn looks stuck, and its check-ins can't reach it.
 */
export const STUCK_CLOCK_SKIPS = 3;

/** Why a run skips when its agent is mid-turn (`whyNotReady`). */
export const STILL_WORKING = 'it was still working';

/** Why a run skips when its agent waits for the user: a question, a permission prompt (`whyNotReady`). */
export const WAITING_FOR_YOU = 'it was waiting for you';

/**
 * What a clock is doing: when it next fires (null while not planned), its latest runs, newest first, and the skips its
 * latest runs are, if they are (`skips`, null when its latest run is not a skip).
 */
export interface ClockStatus {
  id: string;
  nextRunAt: string | null;
  runs: ClockRun[];
  skips: ClockSkips | null;
  /** The changes its agents made to it (`clock.self`), newest first, at most `CLOCK_RUNS_KEPT`. */
  changes: ClockChange[];
}

/** Where `clock.add` puts a new clock: beside an agent's tile (on its left, joined to it), or at a place. */
export type ClockPlace = { beside: string } | { zoneId: string | null; x: number; y: number };

/**
 * A tool call waiting for the user's permission, from the harness's `PermissionRequest` hook. While the daemon holds
 * that hook open, the needs-you inbox can answer it (`agent.decidePermission`). Once the hold ends unanswered, the
 * harness asks in its own terminal instead, and the prompt stays as context until it is settled there.
 */
export interface PermissionPrompt {
  /** Names this request, so a decision can't land on another one. */
  id: string;
  /** The harness's `tool_name`, e.g. `Bash`. */
  toolName: string;
  /** The harness's `tool_input`, e.g. `{ command: 'rm -rf dist' }`. */
  toolInput: unknown;
  /** The subagent that asked (its `agent_id` and `agent_type`), or null for the agent itself. */
  subagent: { id: string; type: string } | null;
  requestedAt: string;
  /** While the daemon holds the hook, when the hold lapses to the terminal; null once only the terminal can answer. */
  heldUntil: string | null;
  /**
   * Whether the harness asks in its own terminal while the hook is held (Claude, for the agent itself), so either can
   * answer, rather than waiting on the hold to lapse first (Codex, a Claude subagent).
   */
  asksInTerminal: boolean;
  /**
   * What an allow for the session would grant, in words ("npm run:*", "all edits"): the rule the harness suggested with
   * the request (Claude does). Null where it suggested none, or none that can be worded; then it can't be offered.
   */
  sessionGrant: string | null;
  /**
   * For a call of Claude's question tool (`QUESTION_TOOL`), its questions: the harness's own dialog asks them and takes
   * the answers, so the prompt is never held and can't be allowed or denied from the board. Null for any other call.
   */
  questions: PromptQuestion[] | null;
}

/** Claude Code's tool that asks the user questions with options; its PermissionRequest is its dialog, not a permission. */
export const QUESTION_TOOL = 'AskUserQuestion';

/** One question of a question-tool call: its text, its short header, its options and whether several can be picked. */
export interface PromptQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** The agent's prompt that asks it questions (`PermissionPrompt.questions`), if one is up. */
export function questionPrompt(agent: Pick<Agent, 'permissions'>): (PermissionPrompt & { questions: PromptQuestion[] }) | undefined {
  return agent.permissions.find((prompt): prompt is PermissionPrompt & { questions: PromptQuestion[] } => prompt.questions !== null);
}

/** The agent's first prompt that asks for a permission, not questions, if one is up. */
export function permissionPrompt(agent: Pick<Agent, 'permissions'>): PermissionPrompt | undefined {
  return agent.permissions.find((prompt) => prompt.questions === null);
}

/**
 * The user's answer to a permission prompt. A deny's `message` tells the agent why. An allow with `scope: 'session'`
 * also grants what the harness suggested for the rest of the session; only for a prompt with a `sessionGrant`.
 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  scope?: 'session';
}

/** One question of an ask: its words, the answers it offers, and whether the user may reply in their own words. */
export interface AskQuestion {
  question: string;
  /** The answers it offers, each a button; at most `MAX_ASK_OPTIONS`. */
  options: string[];
  /** Whether the user may reply in their own words: always, for a question with no options. */
  freeText: boolean;
}

/**
 * What an agent asks the user through the board (`board.ask`): one to `MAX_ASK_QUESTIONS` questions, in the
 * needs-you inbox and on its tile until the user sends the answers or skips it, it times out, or the agent stops
 * waiting (its call cancelled, its turn over). Only the user's click answers it: a timeout tells the agent there was no
 * answer. `question`, `options` and `freeText` are its first question's.
 */
export interface AgentAsk {
  /** Names this question, so an answer can't land on another one. */
  id: string;
  question: string;
  /** The answers it offers, each a button; at most `MAX_ASK_OPTIONS`. */
  options: string[];
  /** Whether the user may reply in their own words: always, for a question with no options. */
  freeText: boolean;
  askedAt: string;
  /** When it stops waiting, with no answer. */
  expiresAt: string;
  /** Whether the agent asked for it on the board (`on_board`): put there at once, as a steps card beside its tile (`card`). */
  onBoard: boolean;
  /** Every question it asks, the first being `question`; one for a single question. */
  questions: AskQuestion[];
  /** The user's answers so far, one per question (null while unanswered), kept until it is sent or goes. */
  answers: (AskAnswer | null)[];
  /** The steps card it was put on (Put on the board): answered there from then on, its Send answering the call. */
  card: string | null;
}

/** The user's answer to an agent's question: one of its options (by index), their own words, or skipping it. */
export type AskAnswer = { option: number } | { text: string } | { skip: true };

/**
 * What `board.ask` tells the agent: the answer, or that there was none. An ask of several questions has `answers`, one
 * per question, and `answer` is its first; `outcome` is `answered` once any is.
 */
export interface AskResult {
  outcome: 'answered' | 'skipped' | 'timed-out';
  /** The option picked, or the user's words; null with no answer. */
  answer: string | null;
  /** Each question and its answer (null for one left unanswered), for an ask of more than one question. */
  answers?: { question: string; answer: string | null }[];
  /** The steps card that holds its questions, if it was put on the board or kept there as it ended half-answered. */
  card?: string;
}

/** Most options a question offers: one per key 1-9. */
export const MAX_ASK_OPTIONS = 9;
/** Most questions one ask holds, as Claude's own question tool asks at most: more, and it is a steps card. */
export const MAX_ASK_QUESTIONS = 4;
/** Longest question, and option, an agent may ask. */
export const MAX_QUESTION_LENGTH = 2_000;
export const MAX_OPTION_LENGTH = 200;
/** Longest plan title, and plan body (Markdown or HTML), in characters. */
export const MAX_PLAN_TITLE_LENGTH = 200;
export const MAX_PLAN_LENGTH = 1_000_000;
/** Longest reply or comments the user sends back. */
export const MAX_REPLY_LENGTH = 20_000;

/**
 * How long a question and a plan wait for the user by default, and at most. Unlike `orchestrator.wait`, the call blocks
 * for all of it: Claude gives a stdio MCP tool call far longer than this, and Codex is given `tool_timeout_sec` over the
 * longest (ADR-0014).
 */
export const DEFAULT_ASK_WAIT_MS = 30 * 60_000;
export const DEFAULT_PLAN_WAIT_MS = 60 * 60_000;
export const MAX_ASK_WAIT_MS = 4 * 60 * 60_000;

/** How a plan is written: rendered as Markdown, or as untrusted HTML in a locked-down view of its own. */
export const PLAN_FORMATS = ['markdown', 'html'] as const;
export type PlanFormat = (typeof PLAN_FORMATS)[number];

/** The decisions the user makes on a plan. */
export const PLAN_OUTCOMES = ['approved', 'changes-requested', 'rejected'] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/**
 * How a plan ended: the user's decision, or none, as it `timed-out` or was `withdrawn` (the agent stopped waiting: its
 * call cancelled, its turn over, its session or the daemon gone), or `edited`: the user saved their own version of it,
 * the next one, which the decision then applies to.
 */
export interface PlanDecision {
  outcome: PlanOutcome | 'timed-out' | 'withdrawn' | 'edited';
  /** The user's comments for the agent; '' for none. */
  comments: string;
  decidedAt: string;
}

/** A plan an agent presented (`board.presentPlan`), without its body. */
export interface PlanSummary {
  id: string;
  /** 1 for the agent's first plan, then 2, 3… */
  version: number;
  title: string;
  format: PlanFormat;
  presentedAt: string;
  /** When the agent stops waiting on it; null for a plan it left, which waits as long as the user takes. */
  expiresAt: string | null;
  /** The agent left it (`agent-board doc --plan`) and went on: no call of its waits on it, so it isn't mid-turn for it. */
  left: boolean;
  /** Null while the user is still to decide. */
  decision: PlanDecision | null;
  /** Who wrote it: its agent, or the user, who edited the agent's version before deciding. */
  author: DocumentWriter;
  /** The real path of the file it was read from, absolute; null for a plan given inline. */
  path: string | null;
}

/** A plan, with its body. */
export interface Plan extends PlanSummary {
  body: string;
}

/** What `board.presentPlan` answers at once for a plan the agent left (`detached`): the plan, now waiting for the user. */
export interface PlanLeft {
  left: PlanSummary;
}

/** How a plan the agent waited on ended: never `edited`, which only a version the user then edited is stamped with. */
export type PlanEnd = PlanDecision & { outcome: Exclude<PlanDecision['outcome'], 'edited'> };

/** What `board.presentPlan` tells the agent. */
export interface PlanResult {
  version: number;
  decision: PlanEnd;
  /** What the user changed before deciding, if the version decided is theirs; else null. */
  edits: PlanEdits | null;
}

/** The user's edits to a plan, as its agent is told them with the decision. */
export interface PlanEdits {
  /** The agent's version they edited. */
  from: number;
  /** The line diff from the agent's version to the one decided (`text-diff.ts`). */
  diff: string;
  /** The approved version was written to the plan's file. */
  written: boolean;
  /** Why an approved version wasn't written to the plan's file; null when it was, or there was none to write. */
  problem: string | null;
}

/** Whether the agent waits on its latest plan. */
export const planPending = <T extends Pick<Agent, 'plan'>>(agent: T): agent is T & { plan: PlanSummary & { decision: null } } =>
  agent.plan !== null && agent.plan.decision === null;

/** Whether the agent's call waits on the user: a question it asks, or its latest plan, unless it left that and went on. */
export const waitsOnUser = (agent: Pick<Agent, 'ask' | 'plan'>): boolean => agent.ask !== null || (planPending(agent) && !agent.plan.left);

/** The kinds of file an agent shows as a document, by their extensions. */
export const DOCUMENT_EXTENSIONS: Record<PlanFormat, readonly string[]> = { markdown: ['.md', '.markdown'], html: ['.html', '.htm'] };

/** Who last wrote a document: its agent, or the user from its Document tab. */
export type DocumentWriter = 'agent' | 'user';

/**
 * A document an agent shows the user (`board.showDoc`): a Markdown or HTML file of its, shown as a Document tab in its
 * window or a card on the board, read from the file each time so it stays live. Without its text.
 */
export interface DocumentSummary {
  id: string;
  /** The agent that showed it. */
  sessionId: string;
  /** The file, its real path: a link the agent named is shown as the file it leads to. */
  path: string;
  /** As the agent named it; else the first heading (or an HTML page's title), else the file's name. */
  title: string;
  format: PlanFormat;
  /** 1 as it is first shown, then one more for each write seen, the agent's or the user's. */
  version: number;
  writtenAt: string;
  writtenBy: DocumentWriter;
  /** Whether the user may edit it: Markdown, inside its agent's worktree. */
  editable: boolean;
  /** When the agent last showed it. */
  shownAt: string;
}

/** A document with its text as the file holds it now; null with a problem when the file can't be read. */
export interface DocumentContent extends DocumentSummary {
  text: string | null;
  problem?: string;
}

/** A document card's size, open, and its height as a slim bar. */
export const DOCUMENT_CARD_SIZE = { width: 256, height: 208 };
export const DOCUMENT_BAR_HEIGHT = 76;
/** The smallest a document card can be dragged to. */
export const DOCUMENT_MIN_SIZE = { width: 160, height: 120 };

/** A document card's `data`: which document it shows, and who showed it, as they were then. */
export interface DocumentCardData {
  documentId: string;
  agent: AgentNoteAuthor;
  title: string;
  format: PlanFormat;
  /** Drawn as a slim bar (type, title and author) instead of a page with a preview. */
  collapsed: boolean;
  /** The height the user gave the page, kept while it is a slim bar so showing the page again restores it. */
  openHeight?: number;
}

/** A plan card's size. */
export const PLAN_CARD_SIZE = { width: 256, height: 132 };

/**
 * A plan card's `data`: whose plans it shows, as they were then, and the title of the plan it was put there for. It
 * shows the agent's latest plan as it is now, so one card follows every version.
 */
export interface PlanCardData {
  agent: AgentNoteAuthor;
  title: string;
}

/**
 * The kinds of step on a steps card: a to-do, ticked by whoever it names, or a question: pick one, pick any, yes or no,
 * put in order, or in the answerer's own words.
 */
export const STEP_KINDS = ['todo', 'one', 'any', 'yes-no', 'order', 'words'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** A new steps card's size. */
export const STEPS_CARD_SIZE = { width: 280, height: 104 };
/** A steps card's size folded to its icon tile. */
export const STEPS_ICON_SIZE = { width: 120, height: 120 };

/** The most steps a steps card holds. */
export const MAX_STEPS = 50;
/** The most questions one set asks. */
export const MAX_STEPS_QUESTIONS = 12;
/** The most choices a pick-one or pick-any question offers. */
export const MAX_STEP_CHOICES = 9;
/** The most rows a put-in-order question ranks. */
export const MAX_STEP_RANKED = 6;
/** The longest answer in words. */
export const MAX_STEP_ANSWER = 2_000;
/** The longest a step's text, a choice, a section heading or a link is. */
export const MAX_STEP_TEXT = 500;
/** The least choices a pick-one, pick-any or put-in-order question offers. */
export const MIN_STEP_CHOICES = 2;

/** Who does a step, made a set or answers its questions: the user, or an agent, by its session and its name then. */
export type StepsWho = { kind: 'user' } | { kind: 'agent'; sessionId: string; name: string };

/**
 * An answer to a question step, by its kind: `one` the index of the choice picked, `any` those picked (none is an
 * answer), `yes`, `order` every choice's index in the order put, best first, and `words` the answer as written.
 */
export type StepAnswer = { one: number } | { any: number[] } | { yes: boolean } | { order: number[] } | { words: string };

/** One step of a steps card. */
export interface Step {
  /** Stays as steps are added: what the app and the user's answers name it by. */
  id: string;
  kind: StepKind;
  text: string;
  /** The `## heading` it sits under, or null before the first one. */
  section: string | null;
  /** A question the set can't be sent without; a to-do the list isn't finished without. Off by default. */
  required: boolean;
  /** A question's choices, in the order offered; none for a to-do, yes or no, or words. */
  choices: string[];
  /** A to-do's: who ticks it. Null for a question, which the set's `answeredBy` answers. */
  who: StepsWho | null;
  /** A to-do's link (`-> link`): a URL, a path, or a board ref such as a job it stands for. */
  link: string | null;
  /** A to-do ticked: by whom and when. */
  done: { by: StepsWho; at: string } | null;
  /** A question answered: the answer, by whom and when. */
  answer: { value: StepAnswer; by: StepsWho; at: string } | null;
}

/**
 * A steps card's `data`: an ordered list of steps, each a question or a to-do, which the user or an agent made. Its
 * questions are answered by `answeredBy`, and go to its maker as one message on Send. Its scope is where it sits: in a
 * zone, that zone's agents' (and the orchestrators whose scope reaches it); loose, every agent's.
 */
export interface StepsData {
  title: string;
  madeBy: StepsWho;
  /** Who answers its questions: the user, or, for a set a crew member made, its orchestrator. */
  answeredBy: StepsWho;
  steps: Step[];
  /** When the answers were last sent, and a fingerprint of each in words, by step id: a later Send tells only what changed. */
  sent: { at: string; answers: Record<string, string> } | null;
  /** The agents told at their prompt once a step is done (`steps wait`), or the card closes, by step id. */
  waits: { sessionId: string; stepId: string }[];
  /** Its maker closed it: nothing is answered, ticked or added from then on. */
  closedAt: string | null;
  /** The user folded it to its icon tile. */
  collapsed?: boolean;
  /**
   * The agent's ask it was made from (Put on the board, or an ask that ended half-answered): while `ended` is null the
   * agent's call still waits, and Send answers it there instead of typing at its prompt.
   */
  fromAsk?: { askId: string; ended: { at: string; how: StepsAskEnd } | null };
}

/** How the ask a steps card was made from ended: its answers sent on the card, or the agent stopped waiting. */
export const STEPS_ASK_ENDS = ['sent', 'timed-out', 'stopped'] as const;
export type StepsAskEnd = (typeof STEPS_ASK_ENDS)[number];

/** A step as an agent writes it (`steps new`, `steps add`): `who` null for its maker, `done` for one already ticked. */
export interface StepDraft {
  kind: StepKind;
  text: string;
  section: string | null;
  required: boolean;
  choices: string[];
  who: { kind: 'user' } | { kind: 'agent'; sessionId: string } | null;
  link: string | null;
  done: boolean;
}

/** A change an agent makes to a steps card (`board.updateSteps`); `step` is a step's place, from 1. */
export type StepsChange =
  | { action: 'done'; step: number; undo?: boolean }
  | { action: 'wait'; step: number }
  | { action: 'add'; steps: StepDraft[] }
  | { action: 'answer'; step: number; answer: StepAnswer }
  | { action: 'send' }
  | { action: 'close' };

/** A new memory card's size. */
export const MEMORY_CARD_SIZE = { width: 340, height: 220 };
/** A memory or a queue folded to its icon: its glyph on a round face, with its name under it. */
export const LIST_CARD_FOLDED_SIZE = { width: 128, height: 132 };
/** A new queue card's size: its head, a line of counts, the first jobs and the add box. */
export const QUEUE_CARD_SIZE = { width: 340, height: 244 };

/** The most entries a memory holds. */
export const MAX_MEMORY_ENTRIES = 500;
/** The longest a memory's key is. */
export const MAX_MEMORY_KEY = 120;
/** The longest an entry's value or note is, in characters. */
export const MAX_MEMORY_VALUE = 4_000;
/** The biggest file a memory keeps whole, in bytes of UTF-8. */
export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
/** The most a memory holds in all, its entries' texts in bytes of UTF-8. */
export const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
/** The most open jobs (and notes) a queue holds; done ones don't count. */
export const MAX_QUEUE_OPEN = 200;
/** The longest a job's brief, or a queue's note, is. */
export const MAX_JOB_TEXT = 16_000;
/** The longest a job's link is. */
export const MAX_JOB_LINK = 500;
/** How many of a row's past versions are kept: its value after each change, newest first. */
export const MAX_HISTORY_VERSIONS = 20;
/** Days an entry goes untouched (neither changed nor confirmed) before it reads as stale. */
export const MEMORY_OLD_DAYS = 30;

/**
 * Who a queue is for: agents, which take its jobs, or the user, who goes through it one at a time and whose jobs no agent
 * takes.
 */
export const QUEUE_AUDIENCES = ['agents', 'user'] as const;
export type QueueAudience = (typeof QUEUE_AUDIENCES)[number];

/**
 * A memory card's `data`: shared context that agents read and write with a tool, and people on the board. Its entries are
 * in their own table (`MemoryEntry`). Its scope is where it sits, as a steps card's is, unless `noAgents`: then only the
 * user reads it. `count` is how many entries it holds, kept for the card to show. `folded`, it is drawn as its icon alone.
 */
export interface MemoryData {
  title: string;
  madeBy: StepsWho;
  noAgents: boolean;
  count: number;
  folded?: boolean;
}

/** How many times a job may be dropped back before a queue's drain leaves it for a person. */
export const MAX_DRAIN_DROPS = 2;

/** The most agents a queue's drain keeps working on its jobs at once. */
export const MAX_DRAIN_AGENTS = 3;

/**
 * A queue's drain: while `on`, the board starts a fresh agent (as a clock does: its harness, model and role) for each
 * waiting job, the job taken for it and its text its task, while fewer than `most` of the queue's jobs are taken, by
 * anyone. Only in a zone, the agents starting there. `started` lists the agents it started, for `closeWhenDone`: one
 * that ends a turn holding none of its jobs is closed.
 */
export interface QueueDrain extends ClockFreshAgent {
  on: boolean;
  most: number;
  started: string[];
}

/**
 * A queue card's `data`: jobs and notes in order, in their own table (`QueueJob`). `count` is how many are open. `folded`,
 * it is drawn as its icon alone. `drain`, once set, says whether the board starts agents for its jobs.
 */
export interface QueueData {
  title: string;
  madeBy: StepsWho;
  audience: QueueAudience;
  noAgents: boolean;
  count: number;
  folded?: boolean;
  drain?: QueueDrain;
}

/**
 * One entry of a memory: a keyed value (setting a key again replaces it), a keyless note, or a file kept whole under its
 * name as its key.
 */
export interface MemoryEntry {
  id: string;
  memoryId: string;
  key: string | null;
  file: boolean;
  text: string;
  pinned: boolean;
  madeBy: StepsWho;
  /** Who changed it last: anyone in scope may, and its history takes a change back. */
  changedBy: StepsWho;
  createdAt: string;
  updatedAt: string;
  /** Set on a document an agent's read of its memory lists by its title alone: its size, its `text` then left out (''). */
  listed?: { bytes: number; lines: number };
}

/** The kinds of row a queue holds: a job, which is taken and done, and a plain note, which is neither. */
export const QUEUE_ROW_KINDS = ['job', 'note'] as const;
export type QueueRowKind = (typeof QUEUE_ROW_KINDS)[number];

/** Where a job is: waiting, taken by an agent (a lease its session holds), or done. A note is always queued. */
export type QueueJobState = 'queued' | 'taken' | 'done';

/** One job, or note, of a queue, in its order. */
export interface QueueJob {
  id: string;
  queueId: string;
  kind: QueueRowKind;
  text: string;
  link: string | null;
  state: QueueJobState;
  /** Its taker while taken. */
  takenBy: StepsWho | null;
  takenAt: string | null;
  /** How many times it was dropped back: by its taker, or as its taker's session ended mid-job. */
  drops: number;
  doneBy: StepsWho | null;
  doneAt: string | null;
  madeBy: StepsWho;
  /** Who changed it last, and how: from its history, so a card credits the change to whoever made it. */
  changedBy: StepsWho;
  lastChange: QueueJobChange;
  createdAt: string;
  updatedAt: string;
}

/** A job an agent holds, with the queue it is from. */
export interface TakenJob {
  sessionId: string;
  queueId: string;
  queueTitle: string;
  job: QueueJob;
}

/** What last happened to a job or note, as its history records it. */
export type QueueJobChange = 'add' | 'edit' | 'take' | 'drop' | 'done' | 'restore';

/** How many agents read an entry, or any of a memory's, and who last did. */
export interface MemoryReaders {
  count: number;
  last: { name: string; at: string } | null;
}

/** A memory, or a queue, with what it holds. */
export interface MemoryView {
  item: BoardItem;
  entries: MemoryEntry[];
  /**
   * Who read them: an agent reads an entry when its whole text comes back to it (a fact or note as a memory is read, a
   * document only when named). `entries` holds those of the entries given, by id.
   */
  readers: { memory: MemoryReaders; entries: Record<string, MemoryReaders> };
}
export interface QueueView {
  item: BoardItem;
  jobs: QueueJob[];
}

/** One version of an entry or a job: its value after a change (null once removed, or for a confirm), by whom and when. */
export interface HistoryVersion<Row> {
  /** What a restore names it by; higher is newer. */
  version: number;
  action: string;
  value: Row | null;
  by: StepsWho;
  at: string;
}

/**
 * A change to a memory. `entry` names an entry by its key, or by its id or the start of it. `add` with a key that is
 * there already replaces its value; `restore` puts back one of its versions, after a remove too. `confirm` says an entry
 * is still true: it is touched, so it no longer reads as stale, and its history gets a `confirm` row with no value, which
 * no restore takes and no trim counts.
 */
export type MemoryChange =
  | { action: 'add'; key?: string | null; text: string; file?: boolean }
  | { action: 'edit'; entry: string; text?: string; key?: string | null; pinned?: boolean }
  | { action: 'remove'; entry: string }
  | { action: 'restore'; entry: string; version: number }
  | { action: 'confirm'; entry: string };

/**
 * A change to a queue. `job` names a job or note by its id or the start of it. `take` without `job` takes the first
 * queued job. `drop` puts a taken job back at the front, counting the drop; `restore` puts back a version's text and link.
 * `move` puts an open job or note just before the open one `before`, or last for null.
 */
export type QueueChange =
  | { action: 'add'; kind?: QueueRowKind; text: string; link?: string | null; front?: boolean }
  | { action: 'edit'; job: string; text?: string; link?: string | null }
  | { action: 'remove'; job: string }
  | { action: 'take'; job?: string }
  | { action: 'drop'; job: string }
  | { action: 'done'; job: string }
  | { action: 'restore'; job: string; version: number }
  | { action: 'move'; job: string; before: string | null };

/** A new to-do list's size: its head, three lines and its foot. */
export const TODO_CARD_SIZE = { width: 300, height: 196 };
/** A to-do list folded to its pill: its tick and how many are left. */
export const TODO_PILL_SIZE = { width: 184, height: 36 };
/** The most lines a to-do list holds, ticked ones too. */
export const MAX_TODO_LINES = 100;
/** The longest a to-do line is, in characters. */
export const MAX_TODO_TEXT = 500;

/**
 * One line of a to-do list: something for the user to do. Ticking it changes nothing else and tells no one: who ticked
 * it and when is kept, for its writer to read if it asks.
 */
export interface TodoLine {
  /** Stays as lines are added, moved and ticked. */
  id: string;
  text: string;
  /** Who wrote it: the list's agent, or the user. */
  by: StepsWho;
  at: string;
  done: { by: StepsWho; at: string } | null;
}

/**
 * A to-do list's `data`: reminders for the user. An agent's list (`owner` the agent) is made by its first `remind`,
 * under its tile, and stays after the agent has gone; the user's own lists are the user's. Its scope is a steps card's.
 */
export interface TodoData {
  owner: StepsWho;
  lines: TodoLine[];
  /** Folded to its pill. */
  folded?: boolean;
}

/**
 * A change to a to-do list. `line` names a line by its id. `add` puts its text after the line `after`, or last;
 * `move` puts a line at place `to` (from 0); `clear` takes the ticked lines off; `restore` puts a line taken off back at
 * place `at`, as it was (an undo).
 */
export type TodoChange =
  | { action: 'add'; text: string; after?: string | null }
  | { action: 'edit'; line: string; text: string }
  | { action: 'tick'; line: string; done: boolean }
  | { action: 'remove'; line: string }
  | { action: 'clear' }
  | { action: 'move'; line: string; to: number }
  | { action: 'restore'; line: TodoLine; at: number };

/** A change an agent makes to a line it wrote on its own list: ticks it, unticks it, or takes it off. */
export type AgentTodoChange = { action: 'tick'; line: string; done: boolean } | { action: 'remove'; line: string };

/**
 * An agent spawned by an agent inside the same harness process (e.g. Claude's Agent tool), drawn as a character on
 * its parent's tile. Known only from its parent's hooks, and only while the daemon runs.
 */
export interface Subagent {
  /** The harness's `agent_id`. */
  id: string;
  /** The harness's `agent_type`, e.g. `Explore`. */
  type: string;
  /** From the hooks fired inside it, and its parent's turn: `done` once it has finished. */
  state: SessionState;
  startedAt: string;
  /** When it finished, or ended with its parent. The daemon stops reporting it 10 s later. */
  endedAt: string | null;
  /** Its final message, once it has finished. */
  result: string | null;
}

/** A command an agent left running in the background, as long as a process of it still runs under the agent. */
export interface BackgroundCommand {
  /** The command line, as the agent ran it. */
  command: string;
  /** When it started. */
  startedAt: string;
}

/** How a message another agent sent reached its receiver: a `send`, an answer to its message, flag or question, or an edge's hand-off. */
export type MessageKind = 'send' | 'reply' | 'hand-off';

/** The ref of the agent with session id `sessionId`: `agent:` and the start of the id, as a sender mark and a trailer name it. */
export const agentRefOf = (sessionId: string): string => `agent:${sessionId.slice(0, 8)}`;

/** A hand-off's head, before its payload (`Hand-off from impl (its plan.md): `): its text, and the payload's name. */
export const HAND_OFF_HEAD = /^Hand-off from .+? \(its ([^)]+)\): /;

/** A send's closing line on who it is from (`[agent-board] From Captain (agent:944e1234)…`), after a blank line at the very end. */
export const SEND_TRAILER = /\n\n(\[agent-board\] From [^\n]+)$/;

/** Who sent a message the board typed at an agent's prompt, as its sender mark names them (ADR-0023). */
export interface MessageSender {
  /** The sending agent's ref, `agent:` and the start of its session id. */
  ref: string;
  name: string;
  kind: MessageKind;
  /** For a hand-off, the payload it carried: `final message`, `plan.md`. */
  payload?: string;
}

/**
 * One thing in an agent's conversation, as the chat view shows it, read from its harness's transcript by a
 * versioned adapter (`transcript-adapters.ts`). A tool's result is its own entry, joined to its call by `id`.
 */
export type ChatEntry = (
  /** `from` names the agent a message came from, which the board typed for it; a message without one is the user's. */
  | { kind: 'user'; text: string; from?: MessageSender }
  | { kind: 'assistant'; text: string }
  /**
   * The model thinking before it answered or called a tool. Claude keeps the text of most of it to itself, so `text` is
   * often empty: the entry then says only that it thought. `since` is the latest time a line before it in the
   * transcript was written (a prompt, a tool's result, a background task's notification): it thought from then until `at`.
   */
  | { kind: 'thinking'; text: string; since?: string }
  /** The conversation was compacted here: what comes before it was summarised for the model. */
  | { kind: 'compacted' }
  /** `input` is the call's arguments, or the raw text of a tool that takes free text (Codex's `exec`). */
  | { kind: 'tool-call'; id: string; name: string; input: unknown }
  /** `agentId` names the subagent a Claude Agent call ran, whose own transcript `agent.subagentTranscript` reads. */
  | { kind: 'tool-result'; id: string; output: string; isError: boolean; agentId?: string }
  /** A message between Codex agents: a task handed to a subagent (its text is encrypted, so empty) or its answer. */
  | { kind: 'subagent-message'; from: string; to: string; text: string }
  /**
   * Something that happened to the turn, e.g. `Interrupted`; `forToolUse` when it was a tool call the user turned down
   * or stopped, the call whose result comes just before it.
   */
  | { kind: 'notice'; text: string; forToolUse?: true }
  /** A background task's report reached the model, a prompt the user didn't type and the chat doesn't show: it can start a turn. */
  | { kind: 'notified' }
  /** The turn ended, after `ms`, from its prompt to its last reply, as Claude counts it. */
  | { kind: 'turn-ended'; ms: number }
) & {
  /** When the harness wrote it (ISO 8601), from its line of the transcript; missing from a line with no timestamp. */
  at?: string;
};

/**
 * What `agent.transcript` read: the entries from `since` on, at most the latest 200. `none` until the agent's harness
 * has named its transcript (with its first hook) or written it; `unsupported`, with why, when the adapter can't read
 * it, so the session window shows only its terminal. `generation` changes when the transcript started over (its file
 * was replaced or cut short, or the daemon restarted): the entries then are the latest, whatever `since` was.
 */
export interface TranscriptChunk {
  status: 'none' | 'ok' | 'unsupported';
  reason?: string;
  generation: number;
  /** The first entry's index. */
  from: number;
  /** Whether there are entries before `from` it doesn't send: too old to keep, or never read in a huge transcript. */
  earlier: boolean;
  entries: ChatEntry[];
}

/**
 * A harness session agent-board did not spawn (started in another terminal), reported by the opt-in global hooks
 * and drawn as a tile in the zone matching its folder, or in the Unsorted group.
 */
export interface ExternalSession {
  /** `<harness>:<session id>`. */
  id: string;
  harness: Harness;
  /** The harness's own session id. */
  sessionId: string;
  /**
   * The zone its tile sits in: where it was put, else the zone its folder is in (the most specific one). Null for loose
   * on the board when it has a `position`. With neither a zone nor a place, the daemon puts it in the Unsorted group: a
   * group zone it makes then, which is an ordinary one.
   */
  zoneId: string | null;
  /**
   * Where its tile was put, in its zone or on the board; null until it has a place, when the board slots it in, and
   * again once the zone it was put in is removed. A tile in a zone that has no place yet is slotted by the board.
   */
  position: TilePosition | null;
  /** The worker's issue and role from its status file, else its worktree's (or folder's) name. */
  name: string;
  /** The folder it started in. */
  cwd: string;
  /** The git working tree `cwd` is in, or null outside git. */
  worktree: string | null;
  /** The branch checked out there when it was first seen. */
  branch: string | null;
  /** Its first prompt, if a hook has shown it. */
  description: string;
  state: SessionState;
  /**
   * Its worktree's status file (`.agent-board/status.json`), or null if there is none, or the file names another
   * session (`session_id`): several sessions may share a worktree, and only the one writing the file is its worker.
   */
  status: StatusFile | null;
  createdAt: string;
  /** When its last hook arrived. */
  lastEventAt: string;
  /** Set once its session ended. */
  endedAt: string | null;
  subagents: Subagent[];
}

/**
 * Where `external.resume` starts the session: `here`, its own folder; `new-worktree`, a new worktree and branch cut
 * from its branch (in git only), in the same folder of it; or a `folder` the user picked.
 */
export type ExternalResumeWhere = 'here' | 'new-worktree' | { folder: string };

/** What `AGENT_ERROR.liveElsewhere` says, and what the app warns before resuming such a session. */
export const LIVE_ELSEWHERE_WARNING =
  'This session may still be running in another terminal; resuming here can interleave two processes on one conversation.';

/** What resuming an external session would mean (`external.resumePlan`). */
export interface ExternalResumePlan {
  /** The folder it started in. */
  cwd: string;
  /** Whether that folder is still there. */
  cwdExists: boolean;
  /**
   * The git checkout it is in: its repo's root, the working tree, its branch now (null when detached), and whether that
   * tree is the repo's main checkout rather than a linked worktree. Null outside git, when no new worktree is offered.
   */
  repo: { root: string; worktree: string; branch: string | null; main: boolean } | null;
  /**
   * Whether it may still be running in another terminal: it never reported its end, or its transcript was written
   * after it did. Resuming it then could interleave two processes on one conversation.
   */
  liveElsewhere: boolean;
}

/** Longest description kept from a session's task or first prompt; tiles show only its start anyway. */
export const MAX_DESCRIPTION_LENGTH = 500;

/** Longest status summary an agent can set: a line or two on its tile. */
export const MAX_STATUS_LENGTH = 200;

/** What an agent may record about its own work: a pull request, a hand-off doc, an agent it started, a pin. */
export const AGENT_RECORD_KINDS = ['pr', 'doc', 'crew', 'pin'] as const;
export type AgentRecordKind = (typeof AGENT_RECORD_KINDS)[number];

/**
 * One entry an agent recorded (`Agent.records`), by its kind and `key`: a pull request's `owner/repo#n`, a doc's
 * absolute path, a crew member's session. Recording the same entry again replaces it, and brings it back once deleted.
 */
export type AgentRecord = {
  key: string;
  recordedAt: string;
  /** When the user deleted it from the sidebar; null while it shows. */
  deletedAt: string | null;
} & (
  | { kind: 'pr'; url: string; title: string | null }
  /** `from` the crew member that recorded it for this orchestrator; null for its own. */
  | { kind: 'doc'; path: string; from: { sessionId: string; name: string } | null }
  | { kind: 'crew' }
  /** `from` the crew member that pinned it for this orchestrator; null for its own. */
  | { kind: 'pin'; target: PinTarget; label: string | null; from: { sessionId: string; name: string } | null }
);

/**
 * What a pin shows the user (`board.record` of kind `pin`): a file by its real path, an http(s) link, or a note's text.
 * Its record's key is the file's path, the link, or `note:` and the note's label; one a crew member pinned for its
 * orchestrator is under `from:<its session>:` too, so it stands beside the orchestrator's own and its other crew's.
 */
export type PinTarget = { kind: 'file'; path: string } | { kind: 'link'; url: string } | { kind: 'note'; text: string };

/** Which pin `board.unpin` takes off: exactly one of a file's path, a link, or a note's label. */
export interface PinRef {
  path?: string;
  url?: string;
  label?: string;
  forOrchestrator?: boolean;
}

/** What `board.record` takes besides the token: a pull request by its URL, a doc by its path, or a pin, for the caller or its orchestrator. */
export type RecordParams =
  | { kind: 'pr'; url: string; title?: string }
  | { kind: 'doc'; path: string; forOrchestrator?: boolean }
  /** Exactly one of `path`, `url` and `note`; a note needs a `label`. */
  | { kind: 'pin'; path?: string; url?: string; note?: string; label?: string; forOrchestrator?: boolean };

/** The most characters of a pin's label, of a pinned note, and of a pinned link. */
export const MAX_PIN_LABEL = 80;
export const MAX_PIN_NOTE = 2000;
export const MAX_PIN_URL = 2048;

/**
 * The icons an agent may pick for its page's tab, a block or a figure: lucide's names, a curated set of content
 * icons. The board's own marks are left out (a pull request, a branch, the crew, the workspace, pins, a robot, a flag,
 * a link's, a note's or a file's row, documents, interrupting, timers and schedules), so each of those keeps one meaning.
 */
export const PAGE_ICONS = [
  'route', 'feather', 'rocket', 'target', 'milestone', 'list-checks', 'gem', 'circle-check', 'gauge', 'trending-up',
  'chart-line', 'chart-bar', 'flask-conical', 'test-tube', 'microscope', 'telescope', 'bug', 'wrench', 'hammer', 'code',
  'braces', 'terminal', 'database', 'server', 'cloud', 'link', 'library', 'scroll-text', 'notebook-pen', 'lightbulb',
  'brain', 'search', 'eye', 'key-round', 'palette', 'image', 'sprout', 'puzzle', 'compass', 'star', 'trophy',
] as const;
export type PageIcon = (typeof PAGE_ICONS)[number];

/** The tones an agent may give a block or a figure. Never orange or red: those mean Needs you and failing, the board's alone. */
export const PAGE_TONES = ['neutral', 'blue', 'green', 'violet', 'teal'] as const;
export type PageTone = (typeof PAGE_TONES)[number];

/** The kinds of block a page is made of. */
export const PAGE_BLOCK_KINDS = ['heading', 'figures', 'checklist', 'callout', 'links', 'note'] as const;

/** The most characters of a page's name (its tab's label), and the most blocks on a page. */
export const MAX_PAGE_NAME = 12;
export const MAX_PAGE_BLOCKS = 12;
/** The most characters of a block's title, of a block's text, and of an item's (a checklist line's, a link's label). */
export const MAX_PAGE_TITLE = 80;
export const MAX_PAGE_TEXT = 2000;
export const MAX_PAGE_ITEM = 200;
/** The most items in a checklist or a links block, and the most figures in a figures block. */
export const MAX_PAGE_ITEMS = 12;
export const MAX_PAGE_FIGURES = 2;
/** The most characters of a figure's value ("214", "18k"), which is drawn large. */
export const MAX_FIGURE_VALUE = 12;

/** A figure in a figures block: a short value and what it counts, with its own icon and tone. */
export interface PageFigure {
  value: string;
  label: string;
  icon: PageIcon | null;
  tone: PageTone;
}

/** Where a checklist's line is: still to do, the one being done now (at most one), or done. */
export const PAGE_CHECK_STATES = ['todo', 'doing', 'done'] as const;
export type PageCheckState = (typeof PAGE_CHECK_STATES)[number];

/** A line of a checklist block. */
export interface PageCheck {
  text: string;
  state: PageCheckState;
}

/** A row of a links block: a link a web tab opens, or a file by its real path; `label` names it, else the link or file does. */
export interface PageLink {
  target: { kind: 'link'; url: string } | { kind: 'file'; path: string };
  label: string | null;
}

/**
 * One block of an agent's page, drawn in order. Every block may have a title, an icon and a tone the agent picks;
 * `tone` is `neutral` unless it picked one.
 */
export type PageBlock = { title: string | null; icon: PageIcon | null; tone: PageTone } & (
  /** What it is up to, in a line or two, with a progress bar when it gives `progress` (0-100). Its title is required. */
  | { kind: 'heading'; text: string | null; progress: number | null }
  /** One or two key figures, side by side. */
  | { kind: 'figures'; figures: PageFigure[] }
  /** Its lines in order; at most one is `doing`, drawn as the current one. */
  | { kind: 'checklist'; items: PageCheck[] }
  /** A thing to notice, set apart. */
  | { kind: 'callout'; text: string }
  | { kind: 'links'; links: PageLink[] }
  /** A titled piece of text, such as test logins. Its title is required. */
  | { kind: 'note'; text: string }
);

/**
 * The page an agent writes for the default shelf of its sidebar (`board.setPage`): the tab's name and icon, and its
 * blocks. Written whole: a new page replaces the old one. `writtenAt` is when it was.
 */
export interface AgentPage {
  name: string;
  icon: PageIcon;
  blocks: PageBlock[];
  writtenAt: string;
}

/**
 * What `board.setPage` takes besides the token, before it is checked: the page's `name` and `icon`, and its `blocks`.
 * A block is `{ kind, title?, icon?, tone?, … }` with, by kind, `text` and `progress` (heading), `figures: [{ value,
 * label, icon?, tone? }]`, `items: [{ text, state? }]` (checklist), `text` (callout, note), or `links: [{ url | path,
 * label? }]`. A field a block doesn't take is refused. A link's relative `path` is from the session's working
 * directory as it started; the CLI and the MCP tool send it absolute, from the caller's working directory.
 */
export interface PageParams {
  name: string;
  icon: string;
  blocks: unknown[];
}

/** The most a hand-off doc may hold for its tab to show it, in bytes. */
export const MAX_DOC_BYTES = 1024 * 1024;

/** What an agent says it is doing now: a short summary, and how far through it is (0-100) if it says. */
export interface AgentStatus {
  summary: string;
  progress: number | null;
  updatedAt: string;
  /** The orchestrator's name when it, not the agent, set this line (`orchestrator.setStatus`); null when the agent did. */
  setBy: string | null;
}

/**
 * The seven work categories (ADR-0024), ordered by who acts next: the user, then what is stuck, then other people,
 * then the agent itself. `work-category.ts` groups them, names them and guesses one for an agent that set none.
 */
export const WORK_CATEGORIES = ['needs-help', 'ready-for-review', 'blocked', 'waiting-on-others', 'in-review', 'working', 'done'] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

/** The most characters an agent's own label for its category may have ("With Legal"). */
export const MAX_WORK_LABEL_LENGTH = 40;

/** The most characters who an agent waits on, or its reference, may have. */
export const MAX_WAITING_ON_LENGTH = 80;

/** Who an agent's work waits on, and a reference of theirs if it gave one (a ticket, a PR): "Northwind Pay support", "#48213". */
export interface WaitingOn {
  who: string;
  ref: string | null;
}

/** A work category as set (`Agent.workCategory`): the category, the agent's own label for it, who it waits on, and when. */
export interface AgentWorkCategory {
  category: WorkCategory;
  /** Shown in place of the category's name; its colour and order stay the category's. Null for the name. */
  label: string | null;
  /** Only for the two categories that wait on others; null otherwise, or when it named no one. */
  waitingOn: WaitingOn | null;
  setAt: string;
  /** The orchestrator's name when it, not the agent, set it; null when the agent did. */
  setBy: string | null;
}

/** A work category as `board.setStatus` and `orchestrator.setStatus` take it: `none` clears it. */
export interface WorkCategoryParams {
  category?: WorkCategory | 'none';
  label?: string;
  waitingOn?: { who: string; ref?: string };
}

/** A category to set (`board.setStatus`, `orchestrator.setStatus`): one of the seven, or null to clear it. */
export interface WorkCategorySet {
  category: WorkCategory | null;
  label?: string;
  waitingOn?: { who: string; ref?: string };
}

/**
 * The pose an agent set for its character (`board.setStatus` with `character`), with its face and prop if it
 * gave them. A working pose goes at its turn's end or `CHARACTER_EXPIRY_MS` after its set; a resting one when its next
 * turn starts (`character.ts`).
 */
export interface AgentCharacter {
  pose: AgentPose;
  face: AgentFace | null;
  prop: AgentProp | null;
  setAt: string;
  /** The orchestrator's name when it, not the agent, set the pose; null when the agent did. */
  setBy: string | null;
}

/**
 * Who a board token belongs to (`board.identify`): the live session it was handed to, and the tile that session is
 * drawn on, an agent's or a shell's, with that tile's zone now (null for loose on the board).
 */
export interface BoardCaller {
  sessionId: string;
  kind: 'agent' | 'shell';
  /** The agent's session, or the shell tile's id. */
  tileId: string;
  name: string;
  zoneId: string | null;
  /**
   * Whom it acts for: `agent` for an agent's own live session; `user` for every other, a shell tile, a tab
   * (an agent's too) and an ended agent's shell, and whatever the user runs in it by hand. The user's side
   * orchestrates at board scope, and may turn orchestrating on and off, but never answers a permission prompt, types
   * into a session or changes another setting (ADR-0010).
   */
  side: 'agent' | 'user';
  /**
   * The scope it may orchestrate in: its agent's, for an agent's own session (null while the user hasn't let
   * it); `board` for the user's side.
   */
  orchestrate: OrchestrateScope | null;
}

/**
 * Where an orchestrator may act (ADR-0011): on the agents in the zone its tile is in now (`zone`), on those of
 * its own repo wherever they sit (`repo`), or on any (`board`); and on the agents it started itself, wherever they are.
 * It starts agents in its zone, or in a zone of its repo, or in any zone, the same way.
 */
export const ORCHESTRATE_SCOPES = ['zone', 'repo', 'board'] as const;
export type OrchestrateScope = (typeof ORCHESTRATE_SCOPES)[number];

/** Where `scope` reaches, in words, as `its` agent's (or `your`): `its zone`, `your repo`, `the whole board`. */
export function orchestrateScopeWords(scope: OrchestrateScope, whose: 'its' | 'your' = 'its'): string {
  return scope === 'board' ? 'the whole board' : `${whose} ${scope}`;
}

/** Whether `value` names an agent state. */
export function isAgentState(value: unknown): value is AgentState {
  return AGENT_STATES.includes(value as AgentState);
}

/**
 * Why an orchestrator may not type `text`, as a first prompt or a message, or undefined when it may (ADR-0011). An
 * allowlist: printable characters, spaces, tabs and line breaks (\n) only, so no control or format character (an
 * escape, a carriage return, a zero-width or bidi mark) can press a key, hide what comes after it, or be dropped on
 * the way to the prompt and leave a command in front. And it may not start, once leading whitespace is gone, as a
 * harness command: `!` (a shell command) or a `/command` (a built-in, which may change a permission mode, a model or a
 * setting), but for a namespaced `/plugin:command`, a plugin's command or skill or a Codex `/prompts:name`.
 */
export function orchestratorTextRefusal(text: string): string | undefined {
  const hidden = /[^\P{C}\t\n]|[\u2028\u2029]/u.exec(text);
  if (hidden !== null) {
    const code = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    return `it holds a control or format character (U+${code}); only printable text, tabs and line breaks may be sent`;
  }
  const start = text.trimStart();
  if (start.startsWith('!')) return 'it starts with !, which runs a shell command';
  if (start.startsWith('/') && !/^\/[\w.-]+:[\w.:-]+(\s|$)/.test(start)) {
    return "it starts with a /command; only a plugin's namespaced /plugin:command may start one";
  }
  return undefined;
}

/**
 * How many agents deep a crew goes: the user's agent, the agents it starts, and theirs. The last never
 * orchestrates by its zone's switch, and no orchestrator that deep starts another, so a loop can't fan out without bound.
 */
export const MAX_CREW_DEPTH = 3;

/** Where the zone setting that lets agents orchestrate is, for messages. */
export const ORCHESTRATE_SETTING = "Let agents orchestrate, in the zone's ⋯ menu";

/**
 * Why the session `caller` may not orchestrate, for it to be told so, and what would change that. `agent` is its tile's
 * agent, if it is one's, with whether the user turned it off and how deep in a crew it is; `zones` are the board's. It
 * may not when its session has ended, the user turned it off, it is as deep in a crew as an agent goes, it is in no
 * zone, or its zone doesn't let agents orchestrate.
 */
export function notOrchestratingReason(
  caller: Pick<BoardCaller, 'sessionId' | 'name'>,
  agent: (Pick<Agent, 'sessionId' | 'endedAt' | 'zoneId'> & { off: boolean; depth: number }) | undefined,
  zones: readonly Pick<Zone, 'id' | 'name' | 'agentsOrchestrate'>[],
): string {
  const { name } = caller;
  if (agent === undefined || agent.sessionId !== caller.sessionId || agent.endedAt !== null) return `${name} may not orchestrate: its session has ended`;
  if (agent.off) return `${name} may not orchestrate: the user turned it off. The user can turn it on again (agent-board orchestrate on)`;
  if (agent.depth >= MAX_CREW_DEPTH - 1) return `${name} may not orchestrate: it is ${MAX_CREW_DEPTH} agents deep in a crew, as deep as a crew goes`;
  const zone = zones.find((each) => each.id === agent.zoneId);
  if (zone === undefined) return `${name} may not orchestrate: it is in no zone, and agents orchestrate in a zone that lets them (${ORCHESTRATE_SETTING})`;
  return `${name} may not orchestrate: orchestrating is off in ${zone.name}. The user can turn it on (${ORCHESTRATE_SETTING})`;
}

/** A conversation an agent left behind when a fresh restart started a new one in its tile. */
export interface EarlierConversation {
  /** The id its harness knew it by (Claude's session id, Codex's conversation id). */
  conversationId: string;
  /** Its transcript file, when its harness's hooks named one. */
  transcriptPath: string | null;
  /** When it was left behind, ISO 8601. */
  endedAt: string;
}

/**
 * What an orchestrator did, or tried: the control verbs, each logged (`OrchestratorActivity`). An edge it made or
 * removed is `add-edge` or `remove-edge`, its target the edge's `to` agent. A `handoff` is any agent's, an orchestrator's
 * or not: one line per edge it handed off along, its target that edge's `to` agent. The layout commands' lines
 * (`move`, `arrange`, `arrange-board`, a group's `add-zone`, `change-zone` and `remove-zone`, a zone's `zone-layout`, a note's `add-note`, `edit-note` and
 * `remove-note`) name the tile, zone or note as their target. `set-role` and `remove-role` change the app's default roles,
 * the role's name their detail. `hold` and `release` (placing and lifting a zone's budget hold) are kept so activity logged
 * before pacing by usage was removed still reads.
 */
export const ORCHESTRATOR_ACTIONS = [
  'spawn',
  'send',
  'interrupt',
  'effort',
  'continue',
  'restart',
  'pause',
  'wake',
  'close',
  'remove',
  'handover',
  'add-edge',
  'remove-edge',
  'handoff',
  'move',
  'arrange',
  'arrange-board',
  'add-zone',
  'change-zone',
  'remove-zone',
  'zone-layout',
  'add-note',
  'edit-note',
  'remove-note',
  'add-shape',
  'add-diagram',
  'edit-shape',
  'remove-shape',
  'connect',
  'edit-connector',
  'remove-connector',
  'add-clock',
  'remove-clock',
  'set-role',
  'remove-role',
  'save-prefab',
  'remove-prefab',
  'save-clock-template',
  'remove-clock-template',
  'stop-crew',
  'crew-round',
  'set-status',
  'hold',
  'release',
] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];

/** What `orchestrator.handover` moved: the agents now in the new orchestrator's crew, and how many things it now made. */
export interface OrchestratorHandover {
  crew: Agent[];
  made: number;
}

/** One line of the orchestrators' activity log: who did, or tried, what to whom, and when. Append-only. */
export interface OrchestratorActivity {
  id: number;
  at: string;
  orchestratorId: string;
  /** Its name then. */
  orchestratorName: string;
  action: OrchestratorAction;
  /** The agent it acted on (for `spawn`, the one it started), or null when a spawn was refused before there was one. */
  targetId: string | null;
  targetName: string | null;
  /** What it asked: the message or prompt it sent, cut short, or the zone and harness of a spawn. */
  detail: string;
  outcome: 'done' | 'refused';
  /** Why it was refused; null when done. */
  reason: string | null;
}

/**
 * The agent an orchestrator starts (`orchestrator.spawn`): as `agent.spawn`, in a zone in its scope (its own by
 * default), without the user's own choices (another repo, a place on the board, Codex project config, orchestrating).
 */
export interface OrchestratorSpawnParams {
  zoneId?: string;
  harness?: Harness;
  model?: string;
  /** As `SpawnAgentParams.effort`. */
  effort?: Effort;
  /** A built-in role, or a custom role's name, as `parseRole` reads it. */
  role?: string;
  /** Without its role's template: its first message is the issue and `prompt` alone. */
  noTemplate?: boolean;
  /** A named role's template to start with in place of its zone's (a crew prefab member's own), checked as one is. */
  template?: string;
  name?: string;
  /** In a group, the repo (an absolute path to it, or a folder in it) to cut its worktree from: the group's without. */
  repo?: string;
  branch?: string;
  baseBranch?: string;
  /**
   * Join a reviewer started on an agent's branch to that agent. None without, since agents talk through `send`: `manual`
   * is an edge each way for the user to press Send on; `auto` hands the reviewer's findings back by itself, the way
   * back manual.
   */
  edges?: 'auto' | 'manual';
  issueId?: string;
  prompt?: string;
}

/** What `orchestrator.spawn` answers: the agent, and which role template its first message began with, if one. */
export type OrchestratorSpawned = Agent & {
  /** The template applied, in words (`the zone's saved implementer template`, `the repo's implementer seed (impl-prompt.md)`); null when none was (none, empty or `noTemplate`). */
  template: string | null;
};

/**
 * How an `orchestrator.send` went. A message: its turn started (`started`); queued until its session is up
 * (`queued-until-up`); the paused agent woken with it, to be typed once its session is up (`waking`); or typed as a
 * turn started meanwhile, its one Enter queueing it for after that turn, not yet seen taken up (`queued-in-turn`); or,
 * to an orchestrator mid-turn, kept by the daemon until its turn ends and then typed, after any sent before it
 * (`queued-after-turn`, `Agent.messagesWaiting`). With `submit`, the unsent message at its prompt: its turn started (`started`). With `clear`, the keys that clear it
 * were typed (`cleared`). One whose turn never started is never any of these: the send is refused, saying so, and it
 * stays the agent's unsent message.
 */
export type SendDelivery = 'started' | 'queued-until-up' | 'waking' | 'queued-in-turn' | 'queued-after-turn' | 'cleared';

/**
 * What `orchestrator.send` answers: the agent, and how the send went. `typed` is the message as the receiver reads it,
 * headed with its sender mark when an agent sent it (ADR-0023); none for `submit` or `clear`.
 */
export type OrchestratorSent = Agent & { delivery: SendDelivery; typed?: string };

/** The sides of a tile or note another is put beside (`orchestrator.move`'s and `addNote`'s `near`). */
export const TILE_SIDES = ['below', 'right', 'left', 'above'] as const;
export type TileSide = (typeof TILE_SIDES)[number];

/** What a layout command moves or puts a note beside: an agent's, a shell's tile, or a board item. */
export interface LayoutTarget {
  kind: 'agent' | 'shell' | 'item';
  /** An agent's session id, a shell tile's or an item's id. */
  id: string;
}

/**
 * Where `orchestrator.move` puts a tile, or `orchestrator.addNote` a note: in the zone `zoneId` (null, loose on the
 * board), at `at` (relative to that zone), or a gap beside `near` on its `side` (`below` without), in `near`'s zone.
 * Each is a wish: what lands there would overlap something is moved the least distance clear of it. Without any, a
 * tile stays in its zone (a note goes in the caller's), at the first free slot.
 */
export interface LayoutPlace {
  zoneId?: string | null;
  at?: { x: number; y: number };
  near?: LayoutTarget;
  side?: TileSide;
}

/** Where a layout command left a tile or note: its zone (null for none) and its place, relative to it. */
export interface LayoutMoved {
  target: LayoutTarget;
  zoneId: string | null;
  x: number;
  y: number;
}

/** What `orchestrator.arrange` groups a row by: an issue (the default), a role or a state. */
export const ARRANGE_BYS = ['issue', 'role', 'state'] as const;
export type ArrangeBy = (typeof ARRANGE_BYS)[number];
/**
 * How it lays the groups out: a row each (the default; by issue, lanes with a column per slot), a column each, a card
 * each (flowed two or three across), filling the zone's width as Tidy does, by issue a lane each that wraps its tiles
 * onto a new row after four (`wrap`; by role or state, as rows), each group a block in the shortest of as many columns
 * as fit the window (`masonry`), or each group a block sized by its tiles in a treemap of the window's shape (`treemap`).
 */
export const ARRANGE_LAYOUTS = ['rows', 'columns', 'cards', 'grid', 'wrap', 'masonry', 'treemap'] as const;
export type ArrangeLayout = (typeof ARRANGE_LAYOUTS)[number];

/**
 * What `orchestrator.arrange` did: the zone, its size now, and where each tile it moved went. `unmeasured` when it laid
 * the zone out from saved sizes and estimates alone: no app window measured what it draws (`layout.measured`), or a
 * lane's note wasn't measured in time.
 */
export interface ArrangeResult {
  zoneId: string;
  width: number;
  height: number;
  moved: LayoutMoved[];
  unmeasured: boolean;
}

/** A box on the board, px: relative to its zone, or a board position when loose. */
export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A tile or item as the app draws it (`layout.measured`), by its key (`agent:<id>`, `shell:<id>`, `item:<id>`):
 * `saved`, the box the app had for it when it measured, which says whether the measure still holds; `drawn`, where and
 * how big it is drawn (a text item at the size its text takes, a tile pushed aside by an expanded one); and for an agent
 * note, the height its text needs at its width (`fits`), with the text it was measured for (`measuredText`).
 */
export interface MeasuredBox {
  key: string;
  saved: BoxRect;
  drawn: BoxRect;
  fits?: { height: number; text: string };
}

/** A tile expanded in place as the app draws it: its key, where it is saved and its expanded size. */
export interface ExpandedBox extends BoxRect {
  key: string;
}

/**
 * What the app says of how it draws the board (`layout.measured`): its boxes, and the tiles expanded in place as it
 * drew them, which where it drew the rest depends on. `away` once its window is no longer in front: it says nothing
 * more until it is again, so nothing waits on it. `window`, how big its window is, px: an arrange packs masonry to its shape.
 */
export interface LayoutMeasured {
  boxes: MeasuredBox[];
  expanded: ExpandedBox[];
  away?: boolean;
  window?: { width: number; height: number };
}

/** The most boxes one `layout.measured` takes. */
export const MAX_MEASURED_BOXES = 5000;

/**
 * A short fingerprint of a note's text, which a measure of its height is for: the measure holds only while the note
 * says the same. FNV-1a, with the length.
 */
export function measuredText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** What `orchestrator.arrangeBoard` did: where each zone and each loose tile it moved went. */
export interface BoardArrangeResult {
  zones: { zoneId: string; x: number; y: number }[];
  moved: LayoutMoved[];
}

/** One thing in a zone, as its map shows it: a tile (`agent:<id>`, `shell:<id>`) or an item (`item:<id>`), relative to the zone. */
export interface ZoneMapThing {
  key: string;
  /** An item's kind (`sticky`, `agent-note`, `text`…); null for a tile. */
  itemKind: string | null;
  name: string;
  /** An agent's state; null for a shell or an item. */
  state: AgentState | null;
  /** Where and how big it is drawn: measured by the app when it was, else as saved. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where it is saved, when it is drawn elsewhere (pushed aside by an expanded tile): what the lint holds it to. */
  saved?: { x: number; y: number };
}

/** A lane of a zone's map: its tiles by slot, by key, and its label's and note's (null for none). */
export interface ZoneMapLane {
  key: string;
  label: string;
  slots: { implementer: string[]; reviewer: string[]; 'follow-up': string[] };
  labelItem: string | null;
  note: string | null;
}

/**
 * What `orchestrator.map` reads of a zone: its lanes as an arrange by issue sees them, where everything in it is, and
 * what is amiss: things on top of each other, the widest gap in a lane (in grid columns), the space between lanes (and
 * from the top row to the first), a label's distance to its lane, a zone bigger than its contents, and the tiles not
 * where an arrange as set would put them now (one no arrange places, off the grid) or out of their lane's row.
 */
export interface ZoneMap {
  zoneId: string;
  name: string;
  width: number;
  height: number;
  /** The caller's arrange settings, which its next arrange (and auto-arrange) uses. */
  arrange: ArrangeSettings;
  /** The zone's spacing, which its arrange uses and the gaps it reports are past. */
  spacing: ArrangeSpacing;
  /** Whether no app window measured what it draws: everything is where and as big as it is saved, or estimated. */
  unmeasured: boolean;
  /** The lead, the shells and the clocks its crew made, then whatever is in no lane (notes, cards, tiles out of scope). */
  top: string[];
  lanes: ZoneMapLane[];
  things: ZoneMapThing[];
  overlaps: [string, string][];
  widestGap: number;
  /** The widest space between a lane and the next across (rows down, columns right), in slots past the gap kept. */
  laneGap: number;
  /** The farthest a lane's label lies from its nearest tile, in slots along the lane past the gap kept. */
  labelGap: number;
  /** The widest band of grid columns, and of rows, running right across the zone with nothing in it, past the gap kept. */
  emptyBands: { columns: number; rows: number };
  offGrid: string[];
}

/**
 * An orchestrator's arrange settings (`orchestrator.arrange` takes and keeps them): what it groups by, how it lays the
 * groups out, and whether it arranges by itself, after every agent it starts, note it adds and agent it closes.
 */
export interface ArrangeSettings {
  by: ArrangeBy;
  layout: ArrangeLayout;
  auto: boolean;
}

export const DEFAULT_ARRANGE_SETTINGS: ArrangeSettings = { by: 'issue', layout: 'rows', auto: false };

/** The kinds of note an orchestrator makes (`orchestrator.addNote`): a sticky note (the default) or a text item. */
export const NOTE_KINDS = ['sticky', 'text'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** What an orchestrator gives a shape it draws (`orchestrator.addShape`, `editShape`). */
export interface DiagramShapeFields {
  shape?: ShapeType;
  /** Its text: a class's name. */
  text?: string;
  /** A class's (or box interface's) sections, a line each; refused for a shape without them. */
  attributes?: string;
  methods?: string;
  /** One of `FILL_SLOTS` by name (any case), `#rrggbb` (a fixed fill), or `none`. */
  fill?: string;
}

/** What an orchestrator gives a connector it draws (`orchestrator.connect`, `editConnector`). */
export interface DiagramConnectorFields {
  /** Sets its ends and dash; `directed` (an arrow at `to`) by default. */
  relation?: RelationId;
  style?: ConnectorStyle;
  /** The text on its middle, and by its `from` and `to` ends (a multiplicity such as `0..*`, or a role). */
  label?: string;
  startLabel?: string;
  endLabel?: string;
}

/**
 * How long `orchestrator.wait` waits at most, and by default: under the 60 s Codex gives an MCP tool call
 * (`tool_timeout_sec`) and the 2 minutes Claude's Bash tool gives a command, so a wait answers, timed out if need be,
 * before the harness gives up on it.
 */
export const MAX_ORCHESTRATOR_WAIT_MS = 30 * 60_000;
export const DEFAULT_ORCHESTRATOR_WAIT_MS = 50_000;

/**
 * The states `orchestrator.wait` waits for by default: any but working (or about to be: `starting`). A turn has ended (at its prompt, asking, or
 * failed), it needs the user, or it has ended.
 */
export const SETTLED_STATES: readonly AgentState[] = AGENT_STATES.filter(
  (state) => state !== 'running' && state !== 'thinking' && state !== 'handing-off' && state !== 'starting',
);

/**
 * What `orchestrator.wait` can wait for: an agent's state, or `finished`, an agent that said its work is finished
 * (`Agent.workFinishedAt`), which a turn ending is not.
 */
export const WAIT_STATES = [...AGENT_STATES, 'finished'] as const;
export type WaitState = (typeof WAIT_STATES)[number];

export function isWaitState(value: unknown): value is WaitState {
  return WAIT_STATES.includes(value as WaitState);
}

/**
 * What happened to an agent of a crew, once each: its turn ended, it finished (`Agent.workFinishedAt`), it needs
 * the user (a permission prompt, a question or a plan), a message typed at its prompt was never sent (`Agent.unsent`),
 * it flagged its orchestrator (`Agent.flag`), its turn failed, it was rate-limited, it was paused (by whom: no end,
 * as a message wakes it), its session ended, or a pull request was opened from its branch. Its idle prompt (Claude's
 * `idle_prompt`, idle to waiting a minute after a turn) is none, and a turn that ends finished is only `finished`.
 * A running crew (`Crew`) adds two of its builder's: a review `round` started, and the crew stopped (`crew-stopped`,
 * saying why).
 */
export const CREW_EVENT_KINDS = ['turn-ended', 'finished', 'needs-you', 'not-sent', 'flagged', 'failed', 'rate-limited', 'paused', 'ended', 'pr-opened', 'round', 'crew-stopped'] as const;
export type CrewEventKind = (typeof CREW_EVENT_KINDS)[number];

export interface CrewEvent {
  /**
   * Its place: the daemon's run and its number in it (`<run>.<n>`), as `orchestrator.wait`'s `since` and `cursor` take
   * it. A cursor of another run is from before the daemon restarted.
   */
  cursor: string;
  at: string;
  sessionId: string;
  /** The agent's name then. */
  name: string;
  kind: CrewEventKind;
  /**
   * What more there is to say, or null: a status summary, what it asks, how its session ended (`closed`, `exited 1`,
   * `removed`), a pull request's number and URL.
   */
  detail: string | null;
}

/** What `orchestrator.wait`'s `since` takes: a crew event's cursor (`<run>.<n>`), `now` or `all`. */
export function isCrewSince(value: string): boolean {
  return value === 'now' || value === 'all' || CREW_CURSOR.test(value);
}

/** A crew event's cursor: the daemon's run and the event's number in it. */
export const CREW_CURSOR = /^([0-9a-z]+)\.(\d+)$/;

/** Most crew events the daemon keeps, in memory: a `since` older than these gets what is left, with `missed` set. */
export const MAX_CREW_EVENTS = 1000;

/** What `orchestrator.wait` saw: the agents as they are, and whether it gave up before they were all (or any) there. */
export interface OrchestratorWaitResult {
  agents: Agent[];
  timedOut: boolean;
  /**
   * With `since`, the crew events after it of the agents waited on, oldest first, at most 100: the wait answers as soon
   * as there is one. Empty without.
   */
  events: CrewEvent[];
  /** Where it read up to: wait again with it as `since` to hear only what came next. */
  cursor: string;
  /**
   * Whether events after `since` were lost before this wait read them: the daemon keeps only the latest, and a `since`
   * from before it restarted gets every event of its new run, but none of what came between.
   */
  missed: boolean;
}

/** What `orchestrator.read` read: the agent's final message, or a file of its worktree. */
export interface OrchestratorReadResult {
  text: string;
  /** The file, relative to its worktree; null for its final message. */
  path: string | null;
}

/** Longest name a user can give an agent tile, a shell tile or a shell pane. */
export const MAX_NAME_LENGTH = 60;

/** A status file (`.agent-board/status.json`, written by a worker's hooks): the contract with its supervisor. */
export interface StatusFile {
  /** As the worker reports it: `running`, `waiting`, `done`, `blocked`, `failed`…; not an `AgentState`. */
  state: string;
  summary: string;
  issue: string | null;
  role: string | null;
  /** The handover doc and review doc paths it named, relative to its worktree or absolute. */
  handover: string | null;
  reviewDoc: string | null;
  updatedAt: string | null;
  /** The session whose hooks write it, and that session's harness, when the file says. */
  sessionId: string | null;
  harness: string | null;
}

/** Whether the opt-in global hooks that report external sessions are installed, per harness. */
export interface ExternalHooksStatus {
  /** Installed for every harness. */
  enabled: boolean;
  harnesses: Record<Harness, { installed: boolean; path: string }>;
}

/** The CLIs onboarding checks: the two harnesses, and the GitHub CLI. */
export const SETUP_TOOLS = ['claude', 'codex', 'gh'] as const;
export type SetupTool = (typeof SETUP_TOOLS)[number];

/**
 * What `setup.check` found of a CLI: whether it is on the daemon's PATH, and if so where, its version and whether it
 * is signed in (each left out when the CLI didn't say). `problem` says why it couldn't be asked: it hung, or could not
 * be run.
 */
export type ToolCheck =
  | { tool: SetupTool; found: false }
  | { tool: SetupTool; found: true; path: string; version?: string; signedIn?: boolean; problem?: string };

/**
 * A shell tile: plain shell sessions in a zone or loose on the board, split into panes tmux-style. Each pane is a
 * session of its own, so the layout and the panes outlive the app; they end with the daemon (their panes stay in the
 * layout, ended, until closed).
 */
export interface Shell {
  id: string;
  /** Null for a shell loose on the board. */
  zoneId: string | null;
  /** Where its tile is; null until it has a place, when the board slots it in. */
  position: TilePosition | null;
  /** Shown on its tile. */
  name: string;
  /**
   * Where its panes start: the folder of the zone it was made in, or the home directory for one made loose or in an
   * unbound zone. Moving the tile never changes it.
   */
  cwd: string;
  layout: PaneLayout;
  /**
   * The folder each pane's shell is in, by session id: where it was last seen after its output went quiet, so it follows
   * `cd` (the tile's folder chip); where it started until then.
   */
  paneFolders: Record<string, string>;
  /** The panes whose process has ended. */
  endedPanes: string[];
  /** The ended panes whose shell ended because the daemon went away (see `SessionInfo.stoppedByRestart`): resumable. */
  stoppedPanes: string[];
  /** How each ended pane's shell exited, by session id: its exit code, or null for one ended by a signal. */
  exitCodes: Record<string, number | null>;
  /** The live panes whose shell is running a command, not sitting at its prompt, as last seen when its output went quiet. */
  busyPanes: string[];
  /** The TCP ports each busy pane's command listens on (a dev server's), by session id: only panes with some. */
  panePorts: Record<string, number[]>;
  /**
   * The live panes whose last command failed, with its exit status, by session id: as the shell's integration reports
   * at its prompt (bash and zsh). Cleared by the next command that succeeds.
   */
  failedCommands: Record<string, number>;
  /**
   * The session window it is a tab of: an agent's, by its session id, or a shell tile's, by its id; null for a
   * shell tile on the board, whose own layout is its window's first tab. An owned shell has no zone or place of its own.
   * The agent's own tab is one too, its first pane the agent's own session, which no shell call ends.
   */
  owner: ShellOwner | null;
  /**
   * Where a tab sits among its owner's tabs, after those with a lower one: null for one made before tabs could
   * move, which sorts first, in the order it was made. A shell tile on the board keeps whatever it had as a tab.
   */
  tabOrder: number | null;
  createdAt: string;
}

/**
 * Where a shell moves to: one of an agent's or a shell tile's tabs, or a shell tile on the board, at
 * `tile` (relative to its zone, as `shell.move` takes it).
 */
export type ShellPlace = { owner: ShellOwner } | { tile: TileMove };

/** Whose session window a shell that is a tab belongs to: an agent's or a shell tile's. */
export interface ShellOwner {
  kind: 'agent' | 'shell';
  /** The agent's session id, or the shell tile's id. */
  id: string;
}

/**
 * Whose session window a layout is: an agent's or a shell tile's, or a tab window's (`tabs`, slice 4), an
 * OS window that is no session's, holding pull request, web and session tabs dragged out of windows on their own. A
 * tab window never owns a shell.
 */
export type WindowOwner = ShellOwner | { kind: 'tabs'; id: string };

/** Whether the shell is one of the owner's tabs (for an agent, its own tab or a shell tab; for a shell tile, a tab after its first). */
export const isOwnedBy = (shell: Pick<Shell, 'owner'>, owner: ShellOwner): boolean => shell.owner?.kind === owner.kind && shell.owner.id === owner.id;

/** Whether the shell is its agent's own tab: the one of its tabs whose panes hold the agent's own session. */
export const isOwnTab = (shell: Pick<Shell, 'owner' | 'layout'>): boolean => shell.owner != null && paneIds(shell.layout).includes(shell.owner.id);

/** The tabs in the order their owner's window shows them: by `tabOrder`, those with none first, as listed. */
export const inTabOrder = <T extends Pick<Shell, 'tabOrder'>>(tabs: readonly T[]): T[] =>
  [...tabs].sort((a, b) => (a.tabOrder ?? -Infinity) - (b.tabOrder ?? -Infinity) || 0);

/** A worktree's package scripts, and the package manager that runs them. */
export interface PackageScripts {
  runner: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** The scripts' names, as `package.json` lists them. */
  scripts: string[];
}

/**
 * Where a new agent's worktree is cut from when it is not its zone's repo: a git repo, or a folder in one, which the
 * agent then starts in; or a new scratch repo the daemon makes for it (`<scratch dir>/<agent name>`).
 */
export type AgentRepo = { path: string } | { scratch: true };

/**
 * The roles an agent can be started in: what its work is in a flow. Each starts with its zone's template for the
 * role (`RoleTemplate`), filled in; a reviewer, and a follow-up reviewer, work on a detached checkout of the branch they
 * review.
 */
export const AGENT_ROLES = ['implementer', 'reviewer', 'follow-up-reviewer', 'custom'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** The longest name a custom role takes: a word or two, as its tile's badge shows it. */
export const MAX_ROLE_NAME_LENGTH = 24;

// Control, format (bidi, zero-width), private-use and unassigned characters, and the line and paragraph separators:
// anything that could hide or reorder what a badge shows.
const CONTROL_CHARACTERS = /[\p{C}\u2028\u2029]/u;

/**
 * A role as typed (`agent-board new --role`, `new_agent`, New agent's role chip): a built-in role by its name, in any
 * case, else a custom role with that name (`designer`, `release prep`), trimmed with its spaces kept single. One field,
 * not a role and a name beside it, so the two can never disagree. Names match in ASCII case only (`Designer` is
 * `designer`; `Élan` is not `élan`), as the database's NOCASE does.
 */
export function parseRole(text: string): { role: AgentRole; name: string | null } | { error: string } {
  if (CONTROL_CHARACTERS.test(text)) return { error: 'a role name has no control characters' };
  const name = text.trim().replace(/ +/g, ' ');
  if (name === '') return { error: 'a role needs a name' };
  const builtIn = AGENT_ROLES.find((role) => role === name.toLowerCase());
  if (builtIn !== undefined) return { role: builtIn, name: null };
  if (name.length > MAX_ROLE_NAME_LENGTH) return { error: `a role name is at most ${MAX_ROLE_NAME_LENGTH} characters` };
  return { role: 'custom', name };
}

/**
 * The named role New agent offers for a zone's orchestrator: a custom role like any other (a zone or the app may keep a
 * template of its own for it), with a template of the app's own when neither does. Matched in ASCII case, as role names are.
 */
export const ORCHESTRATOR_ROLE = 'orchestrator';

/** Whether `role` (as typed, or an agent's custom role name) is the orchestrator role. */
export function isOrchestratorRole(role: string | null): boolean {
  if (role === null) return false;
  const read = parseRole(role);
  return !('error' in read) && read.name !== null && read.name.toLowerCase() === ORCHESTRATOR_ROLE;
}

/** An agent's role as the board names it: a custom role's own name, else the role; null for none. */
export function roleLabel(agent: Pick<Agent, 'role' | 'roleName'>): string | null {
  return agent.roleName ?? agent.role;
}

/** The variables a role template's editor offers to insert, in its order. */
export const TEMPLATE_VARIABLES = ['issue', 'branch', 'worktree', 'prev_review'] as const;

/** The longest role template a zone keeps. */
export const MAX_ROLE_TEMPLATE_LENGTH = 50_000;

/**
 * One of the app's default roles: a custom role's name and the template an agent in it starts with, in any
 * zone that has saved none of its own for the name. Kept by the daemon; a session reads and edits the list with
 * `agent-board roles`.
 */
export interface DefaultRole {
  name: string;
  body: string;
  editedAt: string;
}

/**
 * What a model name may be (`opus`, `claude-opus-5-5[1m]`, `gpt-5-codex`): never an option of the harness's own, nor
 * whitespace, since it is passed as an argument.
 */
export const MODEL_NAME = /^[\w.:@/[\]][\w.:@/[\]-]*$/;

/** How many rounds a crew prefab runs before it stops for the user, by default; from 1 to `MAX_REVIEW_CAP`. */
export const DEFAULT_PREFAB_ROUND_LIMIT = 3;

/** The most members a crew prefab has, and the most subagents one member fans out to. */
export const MAX_PREFAB_MEMBERS = 8;
export const MAX_PREFAB_SUBAGENTS = 5;

/**
 * When a crew prefab's member starts: on the crew's prompt (`prompt`, the builder or the lead), at the builder's first
 * hand-off (`handoff`, its reviewers, on detached checkouts of its branch), or when the lead starts it (`lead`, one of
 * the lead's crew, which the lead runs with its own `new`, `send` and `wait`).
 */
export const PREFAB_STARTS = ['prompt', 'handoff', 'lead'] as const;
export type PrefabStart = (typeof PREFAB_STARTS)[number];

/** Which model a member's subagent runs: its member's, or one of Claude's by name. */
export const PREFAB_SUBAGENT_MODELS = ['member', 'haiku', 'sonnet', 'opus'] as const;
export type PrefabSubagentModel = (typeof PREFAB_SUBAGENT_MODELS)[number];

/** When a subagent runs: every round, the first round only, or only when the diff touches one of `paths`. */
export type PrefabSubagentRuns = 'every-round' | 'first-round' | { paths: string[] };

/**
 * One check a crew prefab's member fans out to, inside its own session through its harness's subagent tool: no tile,
 * worktree, branch or round of its own. The member folds what it found into its one review, tagged with `name`.
 */
export interface PrefabSubagent {
  name: string;
  /** What it checks, in a line. */
  checks: string;
  model: PrefabSubagentModel;
  /** What it may do to the files: read them (the default), or change them too. */
  access: 'read' | 'write';
  runs: PrefabSubagentRuns;
}

/** One member of a crew prefab: the agent it starts, as `new` would start it, and when. */
export interface PrefabMember {
  /** Its key in the prefab (`impl`, `code-review`): lowercase letters, digits and dashes. */
  id: string;
  /** Its role as `parseRole` reads it (`implementer`, `reviewer`, or a named role such as `designer`); null for none. */
  role: string | null;
  /** Its tile's name; made from the prompt without. */
  name: string | null;
  harness: Harness;
  /** Its model, or null for its harness's default. */
  model: string | null;
  /** Its reasoning effort, or null for its harness's own. */
  effort: Effort | null;
  /**
   * The template it starts with in place of its role's, filled in as a role template is. A named role's only (a
   * built-in role's template is each zone's), checked as an orchestrator's prompt is.
   */
  template: string | null;
  starts: PrefabStart;
  subagents: PrefabSubagent[];
}


/**
 * A crew prefab: a saved crew shape, its members, how work passes between them (each member's `starts`), and when the
 * crew stops. It never holds a prompt, issue, repo, branch, approval, edge, key or token. One library for the whole
 * app: the built-ins, and those saved or imported, each by its name in any case.
 */
export interface CrewPrefab {
  name: string;
  /** Its icon's name (`crew`, `review`, `lead`). */
  icon: string;
  /** What it is for, in a line. */
  purpose: string;
  /** Review rounds before the crew stops and asks the user, 1 to `MAX_REVIEW_CAP`. */
  roundLimit: number;
  /** How a crew from it is drawn at first: one card, or a tile for each member. */
  onBoard: 'card' | 'tiles';
  members: PrefabMember[];
}

/** A prefab in the library: the prefab, whether it is one of the app's own, and when it was last saved (null for a built-in). */
export interface LibraryPrefab extends CrewPrefab {
  builtIn: boolean;
  editedAt: string | null;
}

/** What starting a prefab did: the agents it started, and the members that start later, with when. */
export interface PrefabStarted {
  prefab: string;
  started: (OrchestratorSpawned & { member: string })[];
  /**
   * The members that start later, each with the command that starts it as the prefab says: the crew starts those at
   * the hand-off itself, and a lead starts its own.
   */
  later: { member: string; starts: Exclude<PrefabStart, 'prompt'>; command: string }[];
  /** The running crew's id (`Crew.id`), when it has reviewers to start at the hand-off; else null. */
  crew: string | null;
}

/**
 * Why a running crew stopped: every reviewer of its round approved with no blocker open (`ready-to-merge`), its round
 * limit was reached with changes still asked for (`round-limit`), the user or an orchestrator stopped it (`stopped`),
 * its builder's pull request was merged, so its agents were closed (`merged`), or its builder is gone (`builder-gone`).
 */
export const CREW_STOPS = ['ready-to-merge', 'round-limit', 'stopped', 'merged', 'builder-gone'] as const;
export type CrewStop = (typeof CREW_STOPS)[number];

/** A reviewer a running crew started, in the round it reviews. */
export interface CrewReviewer {
  member: string;
  sessionId: string;
  /** Its name as it is, or as last known once it is gone. */
  name: string;
  round: number;
  /** Its review's verdict once it left one, else null: a review that says neither asks for changes. */
  verdict: 'approve' | 'changes-requested' | null;
  /** The blockers its review left open, once it left one. */
  blockers: number | null;
}

/**
 * A crew started from a prefab with reviewers that start at its builder's hand-off. The board runs its loop: at each
 * hand-off it starts that round's reviewers on the builder's branch, and once each has left a review it stops at ready
 * to merge, or hands the reviews back to the builder for the next round, up to its round limit. It passes on only what
 * its agents wrote, and approves, merges and draws nothing.
 */
export interface Crew {
  /** Its id, which `crew:<id>` names. */
  id: string;
  prefab: string;
  zoneId: string | null;
  /** The orchestrator that started it, whose crew its reviewers join; null for the user. */
  startedBy: string | null;
  /** Its builder's session. */
  builder: string;
  round: number;
  roundLimit: number;
  /** Whose turn it is: the builder's, the round's reviewers', or no one's once it stopped. */
  phase: 'building' | 'reviewing' | 'stopped';
  /** One of its agents needs the user (a permission prompt, a question, a plan or a flag): the loop waits for them. */
  needsYou: boolean;
  stopped: CrewStop | null;
  startedAt: string;
  stoppedAt: string | null;
  reviewers: CrewReviewer[];
}

/** The most member rows a crew card grows for: a larger crew's rows scroll. */
const MAX_CREW_CARD_ROWS = 8;
/**
 * A new crew card's size, for a crew of so many members: its title, its rounds, a row for each member, then its last
 * hand-off and its foot, or where it stopped with what the user can do there.
 */
export const crewCardSize = (members: number) => ({ width: 300, height: 176 + 22 * Math.min(Math.max(members, 1), MAX_CREW_CARD_ROWS) });
/** A crew card's size for a builder and two reviewers, where no crew says how many it has. */
export const CREW_CARD_SIZE = crewCardSize(3);
/** The most characters of its prompt a crew card's title keeps. */
export const MAX_CREW_CARD_TITLE = 160;

/** A member of its prefab as a crew card lists it: a row, whether or not its agent has started yet. */
export interface CrewCardMember {
  /** Its key in the prefab, which a `CrewReviewer.member` names. */
  id: string;
  /** Its name in the prefab, else its key. */
  name: string;
  role: string | null;
  harness: Harness;
  model: string | null;
  /** `prompt` for the crew's builder, `handoff` for a reviewer of each round. */
  starts: PrefabStart;
}

/**
 * A crew card's `data` (a `crew` item): one running crew on the board, as its loop has it. The board writes it, from the
 * crew's own record, and writes it again whatever a client sends: only `tiles` is the user's.
 */
export interface CrewCardData {
  /** The crew it shows (`Crew.id`): one card a crew. */
  crewId: string;
  /** What the crew was asked, in a line: its prompt's first, else its prefab's name. */
  title: string;
  /** Its prefab's icon. */
  icon: string;
  /** Whether its members are drawn as tiles beside it, rather than within it: the prefab's `onBoard` until the user says. */
  tiles: boolean;
  members: CrewCardMember[];
  crew: Crew;
  /** When the crew's turn last passed: to its reviewers at a hand-off, or back to its builder with their reviews. */
  phaseAt: string;
  /** Its round's reviewers failed to start: `crew round` tries again. */
  startFailed: boolean;
  /** Why they failed to start, as the daemon said it; null while they haven't, and where no reason was kept. */
  startError: string | null;
}

/** The roles that review a branch: they start on a detached checkout of it, with no branch of their own. */
export const REVIEWER_ROLES: readonly AgentRole[] = ['reviewer', 'follow-up-reviewer'];

/**
 * A zone's prompt template for a role: what an agent started in the role, in the zone or loose in its repo, begins with.
 * Its `{{issue}}`, `{{branch}}`, `{{worktree}}` and `{{prev_review}}` (and the worker prompts' `{{round}}`,
 * `{{impl_worktree}}` and `{{prev_sha}}`) are filled in as plain text when the agent starts.
 */
export interface RoleTemplate {
  /** A built-in role, or a custom role's name. */
  role: string;
  body: string;
  /** The repo's worker prompt it is seeded from (`review-prompt.md`), or null for the app's own. */
  seed: string | null;
  /** Whether its body is the app's default role of its name (`DefaultRole`), the zone having saved none. */
  appDefault: boolean;
  /** When the user last saved it for the zone; null while it is its seed. */
  editedAt: string | null;
}

/**
 * Starts an agent in a new worktree, on a new branch, with `prompt` as its first task. Its repo is `repo` if given,
 * else its zone's (a bound zone's repo, or a group's default repo). In a group with neither it has no repo: it runs in
 * the group's own folder (`Zone.groupFolder`), with no worktree or branch.
 */
export type SpawnAgentParams = TerminalSize & {
  /** The zone its tile starts in, or null for loose on the board (which needs `repo` and `position`). */
  zoneId: string | null;
  /** The repo to cut its worktree from, instead of its zone's. */
  repo?: AgentRepo;
  /** The branch to cut it from: the repo's HEAD without. For a reviewer, the branch it reviews. */
  baseBranch?: string;
  /** Its new branch's name, which the repo must not have yet: made from its name (or issue) without. */
  branch?: string;
  /** `claude` by default. */
  harness?: Harness;
  /** The harness's model (`--model` for Claude, `-m` for Codex): its own default without. A name, never an option. */
  model?: string;
  /**
   * Its reasoning effort (`--effort` for Claude, `model_reasoning_effort` for Codex, which takes no `max`). Without,
   * the Settings default for its role, else for every new agent, else the harness's own.
   */
  effort?: Effort;
  /**
   * Its role, none without: a built-in role, or any other name for a custom role of that name (`designer`), as
   * `parseRole` reads it. It starts with its zone's template for the role, filled in, before the issue and `prompt`.
   * A reviewer or follow-up reviewer starts on a detached checkout of `baseBranch` (the repo's checked-out branch
   * without), the branch it reviews, and takes no `branch` of its own.
   */
  role?: string;
  /**
   * Where it works: `worktree` (the default) in a worktree and branch of its own, or `main` in the repo's own checkout,
   * on the branch checked out there, with no worktree made (deleting it leaves the checkout as it is). Only the user's
   * own spawn takes `main`; an orchestrator's agents each get a worktree. A reviewer, `branch` and `baseBranch` don't go with it.
   */
  checkout?: 'main' | 'worktree';
  /** Start it without its role's template: its first message is the issue and `prompt` alone. */
  noTemplate?: boolean;
  /**
   * The template it starts with in place of its role's: a crew prefab member's own, for a named role only, filled in
   * and checked as a named role's template is.
   */
  template?: string;
  /** Its first message. Empty or missing starts it at its prompt, named `new-agent-N`; no message is sent. */
  prompt?: string;
  /** Start a Codex agent even though its worktree has Codex config of its own (see `AGENT_ERROR.projectCodexConfig`). */
  allowProjectCodexConfig?: boolean;
  /** Shown on its tile; made from the prompt when missing. */
  name?: string;
  /**
   * An issue in the zone's tracker to start from: the agent is linked to it, its branch is named from it
   * (`acme-12-short-title`), and the issue comes first in its prompt, before `prompt`.
   */
  issueId?: string;
  /**
   * The zone whose tracker `issueId` is in, when it isn't the agent's own zone: for an agent started from an issue card
   * loose on the board, or one picked a repo for. Its own zone without.
   */
  issueZoneId?: string;
  /** Where its tile goes: in the zone (the board slots it in without), or on the board for a loose one. */
  position?: { x: number; y: number };
  /** Lets it orchestrate in this scope from the start (`agent.setOrchestrate`). Only the user's own spawn takes it. */
  orchestrate?: OrchestrateScope;
};

/**
 * Whether the daemon can use a tracker: it has a credential for it, or, for GitHub, gh is logged in.
 */
export interface TrackerStatus {
  provider: TrackerProvider;
  connected: boolean;
}

export interface SessionRef {
  sessionId: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A new shell tile: in a zone, where its position may be left to the board, or loose on the board at `position`. */
export type CreateShellTileParams =
  | { zoneId: string; position?: { x: number; y: number } }
  | { zoneId: null; position: { x: number; y: number } };

/** Where a new shell session starts: an absolute path, the home directory by default. */
export type CreateShellParams = TerminalSize & { cwd?: string };

/** Lines of scrollback a session keeps, and a reattaching client gets back. */
export const SCROLLBACK_LINES = 10_000;

export interface DaemonMethods {
  'daemon.health': { params: undefined; result: DaemonHealth };
  /**
   * Makes this connection the one the daemon asks for pictures of zones (`capture.requested`): the app calls it on each
   * connection. The last connection to call it is asked, until it closes.
   */
  'capture.serve': { params: undefined; result: null };
  /** Hands back the picture a `capture.requested` asked for. */
  'capture.deliver': { params: CaptureDelivery; result: null };
  /** Says the picture a `capture.requested` asked for can't be taken, and why. */
  'capture.fail': { params: { id: string; message: string }; result: null };
  /**
   * Shuts the daemon down, ending its sessions. Without `force` it refuses while sessions are live and answers
   * `stopped: false`; either way `liveSessions` says how many there were.
   */
  'daemon.stop': { params: { force?: boolean }; result: { stopped: boolean; liveSessions: number } };
  /**
   * Starts a plain shell (the user's `$SHELL`) in `cwd`, the home directory by default, and gives it a loose shell
   * tile with no place yet, so it is on the board.
   */
  'session.createShell': { params: CreateShellParams; result: SessionInfo };
  /** Live sessions, oldest first. */
  'session.list': { params: undefined; result: SessionInfo[] };
  /**
   * Streams the session to this client: first a `session.snapshot` event with its scrollback and screen, then
   * `session.output` events. Attaching again sends a fresh snapshot. A client that falls too far behind skips the
   * output it could not take and is sent a fresh snapshot once it catches up.
   */
  'session.attach': { params: SessionRef & { streamOnly?: boolean }; result: null };
  /** Stops streaming the session to this client. The session keeps running. */
  'session.detach': { params: SessionRef; result: null };
  'session.write': { params: SessionRef & { data: string }; result: null };
  'session.resize': { params: SessionRef & TerminalSize; result: null };
  /** Ends the session's process, and resolves with the ended session once it has exited. */
  'session.kill': { params: SessionRef; result: SessionInfo };
  /**
   * The folder the session is in now, for the session window's details: looked up for a live session
   * (lookups shared and briefly cached, so many windows cost one), else where it was last seen.
   */
  'session.cwd': { params: SessionRef; result: { cwd: string } };
  /** Every shell tile, and every agent's tab (`owner` set), oldest first. */
  'shell.list': { params: undefined; result: Shell[] };
  /**
   * Opens a shell tab in the owner's session window: a shell where the agent started (its worktree, or its
   * folder there) or in the shell tile's folder, or in `cwd` (absolute); or, given `script`, one running that package
   * script of the owner's folder, named after it. Fails with `invalidParams` for an unknown agent or shell tile, one
   * being deleted, a shell that is itself a tab, a `cwd` that is no folder or an unknown script.
   */
  'shell.createTab': { params: { owner: ShellOwner; cwd?: string; script?: string }; result: Shell };
  /**
   * The agent's own tab, made the first time it is asked for: its one pane the agent's own session, until it is split.
   * Fails with `invalidParams` for an unknown agent.
   */
  'shell.ownTab': { params: { agentId: string }; result: Shell };
  /** The package scripts of the folder the agent started in, or the shell tile's folder, for a tab to run one. */
  'shell.scripts': { params: { owner: ShellOwner }; result: PackageScripts };
  /**
   * Starts a shell tile with one pane: in the zone, a shell in its folder, or loose on the board (`zoneId` null), a
   * shell in the home directory. `position` places its tile (relative to the zone), and is needed for a loose one.
   * Fails with `invalidParams` for an unknown zone.
   */
  'shell.create': { params: CreateShellTileParams; result: Shell };
  /**
   * Moves the shell's tile: within its zone, into another, or out onto the board (`zoneId` null). Its panes stay
   * where they are running. Fails with `invalidParams` for an unknown shell or zone, or an agent's tab.
   */
  'shell.move': { params: { shellId: string } & TileMove; result: Shell };
  /**
   * Splits the pane `sessionId` in two, the new pane a shell after it in `cwd` (absolute), else the tile's folder. `horizontal` puts the
   * panes side by side, `vertical` one above the other. Fails with `invalidParams` for an unknown shell or pane.
   */
  'shell.split': { params: { shellId: string; sessionId: string; direction: SplitDirection; cwd?: string }; result: Shell };
  /** Moves a split's divider; `ratio` is the first pane's share, kept within what leaves both usable. */
  'shell.resizeSplit': { params: { shellId: string; splitId: string; ratio: number }; result: Shell };
  /**
   * Closes the pane, ending its session if it is live. Resolves with the shell, or null when that was its last pane
   * and the tile (or tab) went with it. A shell tile whose first tab loses its last pane while it has more tabs keeps
   * its tile, and its folder: its next tab's panes become its first tab, that tab's row going. Fails with `invalidParams` for an agent's own pane
   * in its tab.
   */
  'shell.closePane': { params: { shellId: string; sessionId: string }; result: Shell | null };
  /**
   * Closes a shell tile's own panes, ending their sessions, its next tab's panes taking their place as its own: what its
   * own tab's × does. Resolves with the tile and the id of the tab that became its own. Fails with `invalidParams` for a
   * tile with no other tab (delete it instead), a tab, or one being deleted.
   */
  'shell.closeOwnPanes': { params: { shellId: string }; result: { tile: Shell; promoted: string } };
  /**
   * Starts an ended pane again: a new shell under the pane's session id, in the folder its shell was last in (else the
   * tile's), showing its old output, above a "restored" line for a pane stopped by restart. Fails with `invalidParams`
   * for a pane still running.
   */
  'shell.resumePane': { params: { shellId: string; sessionId: string }; result: Shell };
  /** Renames the shell's tile, with the limits of `agent.setName`. Fails with `invalidParams` for an unknown shell. */
  'shell.setName': { params: { shellId: string; name: string }; result: Shell };
  /**
   * Labels the pane `sessionId`, shown in its header in place of the tile's name. A null or blank `name` takes the label
   * off. Fails with `invalidParams` for an unknown shell or pane, or a name over `MAX_NAME_LENGTH`.
   */
  'shell.setPaneName': { params: { shellId: string; sessionId: string; name: string | null }; result: Shell };
  /**
   * Ends every pane's session and removes the tile, with its tabs, or the tab. Fails with `invalidParams` for the agent's
   * own tab.
   */
  'shell.delete': { params: { shellId: string }; result: null };
  /**
   * Moves the shell, all its panes, to `to`: into the owner's tabs, after its others (at `order`, as an
   * undo puts one back, if given), or onto the board as a shell tile. Its processes, their output and folders are
   * untouched: only its owner, or its place, changes, and its panes speak for the new one from then on. A shell tile
   * moving into tabs takes its own tabs with it, after it. Resolves with each shell it moved, itself first. Fails with
   * `invalidParams` for the agent's own tab, an owner that is unknown, a tab, the shell itself or being deleted, a
   * shell being deleted, or an unknown zone.
   */
  'shell.moveTab': { params: { shellId: string; to: ShellPlace; order?: number | null }; result: Shell[] };
  /**
   * Moves the pane `sessionId` out of the shell's split into a shell of its own at `to`, named after the
   * pane's label, else the shell's, with the id `id` if given (a redo's). Its process is untouched. Resolves with the new
   * shell, the shell it left and that shell's layout before. Fails with `invalidParams` for a pane alone in its shell
   * (move the shell), the agent's own pane, a taken `id`, or as `shell.moveTab` does for `to`.
   */
  'shell.movePane': {
    params: { shellId: string; sessionId: string; to: ShellPlace; id?: string };
    result: { moved: Shell; source: Shell; layoutBefore: PaneLayout };
  };
  /**
   * Puts the pane `sessionId`, alone in a shell of its own, back into the shell `shellId`, whose layout becomes `layout`:
   * its panes now and that pane. The pane's own shell goes; its process is untouched. Undoes `shell.movePane`. Fails
   * with `invalidParams` for a pane not alone in a shell, one whose shell has tabs, or a layout of other panes.
   */
  'shell.returnPane': { params: { shellId: string; sessionId: string; layout: PaneLayout }; result: Shell };
  /**
   * How the owner's session window lays out its tabs: its panes, each with a strip. Null until its
   * window first saves one, when the window shows one pane holding its tabs in their order.
   */
  'shell.windowLayout': { params: { owner: WindowOwner }; result: WindowLayout | null };
  /**
   * Keeps how the owner's session window lays out its tabs, until the owner goes. Which surfaces it holds is the
   * window's to settle: a tab gone meanwhile is dropped as the window reads it back. Fails with `invalidParams` for a
   * layout that isn't one, an owner `shell.createTab` would refuse, or a tab window's (`tabs`) holding anything but
   * pull request, web and session tabs. Given `base`, the layout the window made it from (null for none), it is kept only
   * if the daemon still has that one: a write made before a tab moved in or out (`shell.moveSurface`) is dropped, as the
   * window hears of the move anyway. Resolves with the layout kept now.
   */
  'shell.setWindowLayout': { params: { owner: WindowOwner; layout: WindowLayout; base?: WindowLayout | null }; result: WindowLayout | null };
  /**
   * Lays the owner's tabs that were split inside themselves before windows had panes out as its window's panes
   *: each pane of such a tab but its first (an agent's own tab keeps the agent) moves out into a tab of its
   * own, its process untouched, and the window splits where the tab was as the tab was split. A shell tile's own panes
   * stay. Resolves with the window's layout as kept (null for none) and the owner's tabs as they are now, so a window
   * lays the layout out against tabs it may not have heard of yet. Fails as `shell.setWindowLayout` does for the owner.
   */
  'shell.unsplitTabs': { params: { owner: WindowOwner }; result: { layout: WindowLayout | null; tabs: Shell[] } };
  /**
   * Moves a tab that is only a place in a window (a pull request, a web page or another session) out of the window
   * `from` and into `to`'s, at `placement` (else its last pane's strip), as one change (slice 4); `from` null
   * puts it into a window from none, and `to` null takes it out of every window. A window laid out by no saved layout
   * yet is laid out from its tabs first; a tab window starts as one pane, and goes (its layout null) with its last tab.
   * Every client hears each window's new layout (`window.layout`). Resolves with both layouts and where the tab was in
   * `from` (for an undo). Fails with `invalidParams` for any other tab, one not in `from`'s window, one `to`'s already
   * shows, a session into its own window, or an owner `shell.createTab` would refuse (one being deleted).
   */
  'shell.moveSurface': {
    params: { surface: Surface; from: WindowOwner | null; to: { owner: WindowOwner; placement?: Placement } | null };
    result: { from: WindowLayout | null; to: WindowLayout | null; was: Placement | null };
  };
  /**
   * Forgets a tab window's layout as the window closes, its tabs with it: only if it is still `layout`, the one the window
   * last showed, so a tab moved in since (a redo as it closed) is kept. Resolves with whether it forgot it. Fails with
   * `invalidParams` for any other owner.
   */
  'shell.forgetWindow': { params: { owner: WindowOwner; layout: WindowLayout }; result: boolean };
  /** Every tab window's layout kept, oldest first: for the board to show again any it has lost track of. */
  'shell.tabWindows': { params: undefined; result: { owner: { kind: 'tabs'; id: string }; layout: WindowLayout }[] };
  /** Every zone, oldest first. */
  'zone.list': { params: undefined; result: Zone[] };
  /**
   * Adds a zone for a folder picked by the user, at board position (x, y): a git root becomes a repo zone, a folder
   * inside a repo a folder zone, and a folder outside git a group whose own folder (`groupFolder`) it is, named after
   * it. Fails with `invalidParams` if the folder is missing.
   */
  'zone.add': { params: { path: string } & NewZoneParams; result: Zone };
  /**
   * Adds an unbound zone at board position (x, y): a name and a colour (`#rrggbb`, the least-used tint by default), no
   * repo. Fails with `invalidParams` for a blank name or a malformed colour.
   */
  'zone.addUnbound': { params: { name: string } & NewZoneParams; result: Zone };
  /**
   * Adds a zone for the GitHub repo `owner/repo`, which the daemon clones into `<repos dir>/<owner>/<repo>` with gh, its
   * tracker the repo's GitHub Issues unless `tracker` names another (a Linear team). The zone is unbound, with its
   * `clone` showing progress in `zone.updated` events, until the clone finishes and it is bound. A clone into a folder
   * that one is already under way into resolves with that clone's zone, and starts nothing. If the clone fails or is
   * cancelled, what it cloned goes (the folder itself, and its owner's, only if the daemon made them), and so does the
   * zone (`zone.removed`), unless sessions were moved into it meanwhile: then it stays, unbound. Fails with
   * `invalidParams` for a repo gh can't see, or when its folder is already there and not empty.
   */
  'zone.clone': { params: { repo: string } & NewZoneParams; result: Zone };
  /** Stops the zone's clone, as a failed one. Fails with `invalidParams` for a zone that isn't cloning. */
  'zone.cancelClone': { params: { id: string }; result: null };
  /**
   * Reads the checkout of the git repo `path` is in: its branch, default branch and whether it has uncommitted changes.
   * Only reads; never touches the checkout. Fails with `invalidParams` for a `path` that is not absolute or not in a git repo.
   */
  'zone.checkoutState': { params: { path: string }; result: CheckoutState };
  /** The folders zones were made for, most recently first, while they are still folders in a git repo. At most 20. */
  'zone.recentFolders': { params: undefined; result: RecentFolder[] };
  /**
   * The GitHub repos gh can see, most recently pushed first, each with its local clone if the daemon knows one. Fails
   * as `tracker.scopes` does for GitHub.
   */
  'zone.githubRepos': { params: undefined; result: GitHubRepoSource[] };
  /**
   * Looks at a folder the user picked: a git repo's root, a folder inside one, or a folder outside git (`repoRoot`
   * null). Nothing is bound. Fails with `invalidParams` for a path that is not absolute or not a folder. With `repo` set
   * it must be a copy of that GitHub repo, its `origin` being that repo; the failure names the repo it is the copy of
   * instead, or says it is not a git repo.
   */
  'zone.checkFolder': { params: { path: string; repo?: string }; result: CheckedFolder };
  /**
   * Looks one level deep in `~/code`, `~/src`, `~/Developer`, `~/projects` and `~/GitHub` (those that exist) for git
   * repos with a GitHub `origin`, and adds them to the clones `zone.githubRepos` knows, until the daemon restarts.
   * Resolves with how many repos it found.
   */
  'zone.findCopies': { params: undefined; result: { found: number } };
  /**
   * Binds an unbound zone, keeping its name: `as: 'repo'` to the git repo `path` is in, as `zone.add` would; `as:
   * 'project'` to a new repo made in `path`, an empty or missing folder. Binding is one-way. Fails with
   * `invalidParams` for an unknown or already-bound zone, a `path` that is not absolute, not in a git repo (`repo`),
   * not empty (`project`), or when git fails. A zone can be unbound again (`zone.unbind`) and then bound anew.
   */
  'zone.bind': { params: { id: string; as: ZoneBinding; path: string }; result: Zone };
  /**
   * Unbinds a zone back into a group: no repo and no default repo. It keeps its tracker, so its issue cards and its
   * agents' links stay as they are, and its issues start agents in a repo picked for each. Its agents keep their own
   * repos, and its shells keep running where they are. Fails with `invalidParams` for an unknown zone or one still cloning.
   */
  'zone.unbind': { params: { id: string }; result: Zone };
  /**
   * Makes a group's folder of the user's (`groupFolder`, one `zone.add` was given outside git) a git repo with `git
   * init`, and binds the zone to it. No commit is made: its agents then get worktrees on branches with none yet. A
   * folder the user made a repo meanwhile is bound as it is. Its agents already running there stay plain-folder ones.
   * Fails with `invalidParams` for an unknown zone, a bound one, or a group whose folder is the app's.
   */
  'zone.initRepo': { params: { id: string }; result: Zone };
  /**
   * Sets an unbound zone's default repo to the git repo (or folder in one) `path` is, or clears it with null. Fails with
   * `invalidParams` for an unknown or bound zone, or a `path` that is not absolute or not in a git repo.
   */
  'zone.setDefaultRepo': { params: { id: string; path: string | null }; result: Zone };
  /** Moves and resizes a zone. Fails with `invalidParams` for an unknown id or a size under `MIN_ZONE_SIZE`. */
  'zone.update': { params: { id: string } & ZoneLayout; result: Zone };
  /**
   * Removes a zone that has nothing in it. Fails with `invalidParams` for an unknown id, or a zone that still has agents.
   * No app surface calls it: the app deletes a zone with `zone.dissolve`. It stays as the daemon's own seam, which its
   * tests make and clear zones with.
   */
  'zone.remove': { params: { id: string }; result: null };
  /**
   * Deletes a zone in one step, and is the app's one way to: every tile of its (agents, shells, external
   * sessions) is put loose on the board where it is drawn, and the zone goes; its board items and connectors stay where
   * they are. No session, worktree or branch is deleted, and the folder of a zone bound to a repo is never touched. All
   * or nothing. With `deleteClone`, a zone that is a managed clone (`managedClone`) also has its clone folder deleted
   * once the zone is gone, and the owner folder above it if that is empty; refused while any agent works in that clone,
   * while it has linked worktrees (kept ones too: their branches live in it) or while another zone is on it, and for
   * a zone that is not a managed clone. If the folder can't be removed the zone is gone all the same, and `cloneError`
   * says why. Fails with `invalidParams` for an unknown id or a zone still
   * cloning.
   */
  'zone.dissolve': { params: { id: string; deleteClone?: boolean }; result: { cloneError: string | null } };
  /**
   * Makes a deleted zone again, under its own id and with everything it had (so undoing a delete restores it, not a
   * look-alike). Its tiles are moved back in by the caller. A snapshot with a `repoRoot` binds it to that repo again; one
   * whose repo no longer resolves, or with none, is a group. Fails with `invalidParams` for an id in use, a blank name,
   * a bad colour, fill opacity or layout, or a default repo or repo root that is not absolute. A default repo that no
   * longer resolves to a git folder is left out. The tracker is trusted as `zone.list` gave it.
   */
  'zone.restore': { params: ZoneSnapshot; result: Zone };
  /** Renames a zone and/or recolours it (`#rrggbb`). Fails with `invalidParams` for an unknown id, a blank name or a bad colour. */
  'zone.setLook': { params: { id: string; name?: string; color?: string; fillOpacity?: number | null }; result: Zone };
  /** The zone's template for each role, in `AGENT_ROLES` order. Fails with `invalidParams` for an unknown zone. */
  'zone.roleTemplates': { params: { id: string }; result: RoleTemplate[] };
  /**
   * Saves the zone's template for a role. Fails with `invalidParams` for an unknown zone or role, or a body over
   * `MAX_ROLE_TEMPLATE_LENGTH`.
   */
  'zone.setRoleTemplate': { params: { id: string; role: string; body: string }; result: RoleTemplate };
  /**
   * Puts the zone's template for a role back to its seed, or a named role's to the app's default for it (else empty).
   * Fails with `invalidParams` for an unknown zone or a bad role.
   */
  'zone.resetRoleTemplate': { params: { id: string; role: string }; result: RoleTemplate };
  /** Changes the zone's settings given. Fails with `invalidParams` for an unknown id, or none given. */
  'zone.configure': { params: { id: string } & Partial<ZoneSettings>; result: Zone };
  /**
   * Folds the zone to a chip while it is not needed: pauses (`agent.pause`) each agent of it that can be, and keeps what
   * cannot (mid-turn, asking you something, a message being sent) live, with why. Its shells keep running, as pausing
   * one would end its work: a fold frees its agents' harnesses, not every terminal. Its place and size are kept.
   * Folding a folded zone does nothing. A zone's folds and unfolds run one at a time, as asked: one asked for while
   * another runs waits for it. Fails with `invalidParams` for an unknown id, or a zone still cloning.
   */
  'zone.fold': { params: { id: string }; result: ZoneFoldResult };
  /**
   * Unfolds the zone to where it was. Wakes none of its paused agents, unless `wake`: then each one its fold paused
   * that is still paused is resumed (`agent.resume`) in its conversation, and one that won't wake stays paused, with
   * why, the zone unfolded all the same. An agent paused any other way (`agent.pause`, `orchestrator.pause`), before the
   * fold or since, is never woken by it. Unfolded without `wake`, its agents are from then on paused as if by hand: a
   * later fold and unfold wakes none of them. Unfolding a zone that is not folded does nothing. Fails with
   * `invalidParams` for an unknown id.
   */
  'zone.unfold': { params: { id: string; wake?: boolean }; result: ZoneUnfoldResult };
  /**
   * Binds the zone to a tracker scope the credential can see, and optionally to one of its projects, spelled as the
   * tracker spells them, or unbinds it with null. Fails with `TRACKER_ERROR.notConnected` before `tracker.connect`, and
   * `invalidParams` for an unknown zone, scope or project.
   */
  'zone.setTracker': { params: { id: string; tracker: ZoneTracker | null }; result: Zone };
  /**
   * Starts an agent in the zone: a new branch and worktree of its repo (ADR-0007), with its harness running in it
   * (in the zone's folder for a folder zone). Fails with `invalidParams` for an unknown zone or harness, an empty
   * prompt, when git can't make the worktree, or when the Codex hook launcher can't be written; and with
   * `AGENT_ERROR.projectCodexConfig` for a Codex agent whose worktree has Codex config of its own, unless
   * `allowProjectCodexConfig`.
   */
  'agent.spawn': { params: SpawnAgentParams; result: Agent };
  /**
   * Starts an agent as `agent.spawn` does, but answers as soon as its tile is on the board (an `agent.starting`
   * event), with the session id it will have. Fails as `agent.spawn` does for what is checked before that; what fails
   * after stays on its tile (`AgentStart.error`).
   */
  'agent.start': { params: SpawnAgentParams; result: { sessionId: string } };
  /** The agents being started, and those whose start failed, oldest first. */
  'agent.starts': { params: undefined; result: AgentStart[] };
  /**
   * Starts a failed start again: from the beginning, `allowProjectCodexConfig` confirming its `confirm` warning; or, for an
   * agent whose harness exited before its first hook (`AgentStartup.failed`), in its worktree with its first message.
   */
  'agent.retryStart': { params: { sessionId: string; allowProjectCodexConfig?: boolean }; result: null };
  /**
   * Renames or moves a start's tile while it starts (`move` relative to its zone, as `agent.move`): its agent takes the
   * name and place the tile has when its session runs. Once it is an agent, renames or moves the agent.
   */
  'agent.updateStart': { params: { sessionId: string; name?: string; move?: TileMove }; result: null };
  /**
   * Takes a start off the board: a failed one, or one still going, which stops before its session would run. One the
   * daemon doesn't know (it restarted since) is told over all the same.
   */
  'agent.dismissStart': { params: { sessionId: string }; result: null };
  /** The name an agent started now with no task would get, the lowest free `new-agent-N`, for a picker to show. */
  'agent.nextName': { params: undefined; result: { name: string } };
  /** Every agent, running or ended, oldest first, with its current state. */
  'agent.list': { params: undefined; result: Agent[] };
  /** Re-reads the branch of every live agent's worktree, so the next `agent.list` shows renames and checkouts. */
  'agent.refreshBranches': { params: undefined; result: null };
  /**
   * Ends the agent's session and removes its worktree and branch. Fails with `AGENT_ERROR.unsavedWork` when the
   * worktree has uncommitted changes or the branch has commits no other branch has, unless `force`. With
   * `keepWorktree` it leaves the worktree and branch as they are (and so never stops short for unsaved work).
   */
  'agent.delete': { params: SessionRef & { force?: boolean; keepWorktree?: boolean }; result: null };
  /**
   * Sends `text` to the agent as the user's next message and submits it. One line is typed at its prompt; text of
   * several lines, or one line with `paste` (the composer sets it for a pasted image's path, as a dropped file is
   * pasted), goes as a bracketed paste, as a terminal pastes, so the harness keeps its line breaks; at a Claude agent a
   * long one goes as several smaller pastes, which it takes as the user's words, not pasted material (`pastePieces`).
   * Control characters other than tab and the line break are dropped either way. Answers to one agent go one at a time. Fails with
   * `invalidParams` for an unknown or ended agent, empty text, or an agent that needs permission (the text would land
   * in its permission dialog).
   */
  /** `queued` when the agent's session wasn't up yet: the message is typed once it is, after its first prompt. */
  'agent.answer': { params: SessionRef & { text: string; paste?: boolean }; result: { queued: boolean } };
  /**
   * The agent's conversation from its harness's transcript, for the chat view: the entries from `since` on, read
   * as the transcript grows. Pass back the `generation` last got; entries start again at 0 when it changes. Fails with
   * `invalidParams` for an unknown agent.
   */
  'agent.transcript': { params: SessionRef & { since?: number; generation?: number }; result: TranscriptChunk };
  /**
   * A Claude subagent's own conversation, whole: the one the agent's call `toolUseId` started (its result's `agentId`,
   * when known, finds it faster). `none` for Codex, whose subagents talk in the agent's own transcript.
   */
  'agent.subagentTranscript': { params: SessionRef & { toolUseId: string; agentId?: string }; result: TranscriptChunk };
  /**
   * Interrupts the agent's turn, as Ctrl-C in its terminal would, and resolves with it `idle` at its prompt, its
   * permission prompts released. Fails with `invalidParams` for an unknown or ended agent, or one with no turn under
   * way (`running`, `thinking` or `needs-permission`): at its prompt, Ctrl-C twice would quit the harness.
   */
  'agent.interrupt': { params: SessionRef; result: Agent };
  /**
   * Resumes the turn of a Claude agent its usage limit stopped (`rate-limited`) on usage credits, as the user asked:
   * never done by itself. It takes the step Claude Code offers for it: the menu Claude opens there is closed with
   * Escape, its cancel, which picks no row (so never one that opens a billing page) and leaves Claude's own continue at
   * the reset armed; then `continue` at its prompt, as Claude puts there itself to carry on at the reset; Enter is
   * pressed again while no turn starts. Resolves with the agent once its turn starts. Fails with `invalidParams`,
   * saying why, for a Codex agent, one not rate-limited (checked again once its turn to be typed at comes, and before each further Escape), ended, with
   * a message never sent, the user typing at its prompt or other text there, or showing neither screen, and when no
   * turn starts.
   */
  'agent.continueOnCredits': { params: SessionRef; result: Agent };
  /**
   * Presses Enter on the message typed at the agent's prompt and never sent (`Agent.unsent`), as a delivery does: again
   * while no turn starts, never once the user types there. It stays unsent, so nothing is typed onto it, until its
   * turn starts or no Enter starts one (the prompt holds nothing to send), and then resolves with the agent, `unsent`
   * cleared; still set only if the user typed at its prompt meanwhile. Fails with `invalidParams` for an unknown or
   * ended agent, one with no unsent message or one already being sent, or one not at its prompt (a turn under way, a
   * permission prompt) or with the user typing there.
   */
  'agent.sendUnsent': { params: SessionRef; result: Agent };
  /**
   * Clears the message typed at the agent's prompt and never sent (`Agent.unsent`): clears its lines at the prompt
   * (Ctrl-U, and Backspace to join each line above), with anything the user typed there, and resolves with the agent,
   * `unsent` cleared, so deliveries type at it again. Fails as `agent.sendUnsent` does, but for the user typing there.
   */
  'agent.clearUnsent': { params: SessionRef; result: Agent };
  /**
   * Sends again, in order, what was sent to the agent before its session was up and never typed (`Agent.undelivered`),
   * and resolves with the agent, `undelivered` cleared, and its flag: each as a message, an ended agent started again
   * with the first. Fails with `invalidParams` for one with none, keeping what it couldn't send.
   */
  'agent.resendUndelivered': { params: SessionRef; result: Agent };
  /** Forgets what was never delivered to the agent (`Agent.undelivered`), and its flag; resolves with the agent. */
  'agent.clearUndelivered': { params: SessionRef; result: Agent };
  /**
   * Types the agent's first prompt its session never said it was up for (`Agent.untypedPrompt`), as the user asked,
   * and resolves with the agent, `untypedPrompt` cleared, and the flag it raised with it: it is typed and submitted as
   * a delivery is, kept as its unsent message if no turn starts on it. Fails with `invalidParams` for an unknown agent or one with none,
   * and while Claude's trust screen is up (`Agent.trustFolder`), where Enter would pick `No, exit`.
   */
  'agent.typeFirstPrompt': { params: SessionRef; result: Agent };
  /**
   * Answers Claude's trust screen (`Agent.trustFolder`) as the user asked: moves its pointer to `Yes, I trust this
   * folder` and presses Enter once its screen shows the pointer there, never before. Claude then trusts the folder from
   * now on, as it records itself; the board writes nothing of it. Its first prompt is typed once its session is up.
   * Resolves with the agent. Fails with `invalidParams` for an unknown agent, one not on the trust screen, or one whose
   * pointer did not move there (answer it in its terminal).
   */
  'agent.trustFolder': { params: SessionRef; result: Agent };
  /**
   * Ends the agent's session and resolves with it `done` (not `failed`: the user stopped it). Its worktree and branch
   * stay. Fails with `invalidParams` for an unknown or ended agent.
   */
  'agent.stop': { params: SessionRef; result: Agent };
  /**
   * Pauses the agent (`hibernated`): ends its session as `agent.stop` does, keeping its tile, worktree, branch and
   * conversation, to free what its harness held. Its pane keeps its last screen, dropping into no shell. Fails with
   * `invalidParams` unless it is live, between turns and asking you nothing (`pauseRefusal`), with no message typed at
   * its prompt. `agent.resume`, a message, a hand-off or a scheduled run wakes it.
   */
  'agent.pause': { params: SessionRef; result: Agent };
  /**
   * Starts an ended agent (`stopped-by-restart`, `hibernated`, or one that exited) again in its worktree, carrying on
   * its conversation with no new prompt (Claude `--resume`, Codex `codex resume`, or a new Codex conversation if it
   * can't).
   * Ends the shell its pane dropped into first: while that shell runs something it fails with `shellBusy`, unless
   * `force`. Resolves with it live, `idle` until its SessionStart. Fails with `invalidParams` for a running or unknown
   * agent, or when its worktree is gone.
   */
  'agent.resume': { params: SessionRef & { force?: boolean }; result: Agent };
  /**
   * Answers the agent's permission prompt `requestId` through its held `PermissionRequest` hook. Fails with
   * `AGENT_ERROR.permissionGone` when that prompt is no longer held: it was answered, or went to the terminal.
   */
  'agent.decidePermission': { params: SessionRef & { requestId: string } & PermissionDecision; result: null };
  /**
   * Releases the agent's held permission prompt `requestId` with no decision, so the harness asks in its terminal at
   * once instead of when the hold lapses. Answers nothing for the user. Fails with `AGENT_ERROR.permissionGone` if it is
   * not held any more.
   */
  'agent.releasePermission': { params: SessionRef & { requestId: string }; result: null };
  /**
   * Links the agent to an issue in the tracker of a zone of its own repo (the one it sits in, if it is one), or
   * unlinks it with null. Its branch stays as it is.
   */
  'agent.link': { params: SessionRef & { issueId: string | null }; result: Agent };
  /**
   * Gives the agent a cron schedule, replacing any it had, or takes it away with null. Fails with `invalidParams` for
   * an unknown agent, a cron expression that can't be used (the message says why) or an empty prompt.
   */
  'agent.setSchedule': { params: SessionRef & { schedule: ScheduleSpec | null }; result: Agent };
  /**
   * Renames the agent's tile. The name is trimmed; an empty one, or one over `MAX_NAME_LENGTH`, fails with
   * `invalidParams`, as does an unknown agent. Its worktree, branch and session id stay as they are.
   */
  'agent.setName': { params: SessionRef & { name: string }; result: Agent };
  /** Mutes the agent's OS notifications, or unmutes them. Fails with `invalidParams` for an unknown agent. */
  'agent.setMuted': { params: SessionRef & { muted: boolean }; result: Agent };
  /**
   * Sets the agent's reasoning effort (`Agent.effort`), which it is started with from now on, and resolves with it and
   * when it takes it (`applies`). A live Claude agent takes it as the user would give it: `/effort <level>` typed at its
   * prompt between turns, now if it is at its prompt with nothing typed there, else once its turn ends and it is
   * (`Agent.effortPending`); never typed into a turn, a question, a permission prompt or the user's own typing. A live
   * Codex agent, which has no command for it, takes it when it is next started, as an ended agent does. Null goes back
   * to the harness's own, which neither harness can be told live: any agent takes that when it is next started. Fails
   * with `invalidParams` for an unknown agent, or a level its harness doesn't take.
   */
  'agent.setEffort': { params: SessionRef & { effort: Effort | null }; result: { agent: Agent; applies: EffortApplies } };
  /**
   * Marks the agent's current ask seen, because its session was opened or focused: it stops needing the user until it
   * asks again. Does nothing unless the agent waits for the user. Fails with `invalidParams` for an unknown agent.
   */
  'agent.markSeen': { params: SessionRef; result: Agent };
  /**
   * Deletes one of the agent's records (`Agent.records`), or with `deleted` false brings it back. A deleted record also
   * hides what is guessed of the same entry, until the agent records it again. The user's alone. Fails with
   * `invalidParams` for an unknown agent or record.
   */
  'agent.setRecordDeleted': { params: SessionRef & { kind: AgentRecordKind; key: string; deleted: boolean }; result: Agent };
  /**
   * Reads one of the agent's hand-off docs or pinned files: a path it recorded, and hasn't had deleted, or its
   * `guessedDoc`. Fails with `invalidParams` for any other path, a file that is gone or one over `MAX_DOC_BYTES`.
   */
  'agent.readDoc': { params: SessionRef & { path: string }; result: { path: string; text: string } };
  /**
   * Lets the agent orchestrate in `scope` (ADR-0011), or stops it with null. Takes effect on its next call. The
   * user's alone: a board token is refused it, an orchestrator's too. Fails with `invalidParams` for an unknown agent
   * or scope.
   */
  'agent.setOrchestrate': { params: SessionRef & { scope: OrchestrateScope | null }; result: Agent };
  /**
   * The orchestrator methods (ADR-0011). Each acts as the session holding `token`: an agent's own session,
   * with `orchestrate` on, else `BOARD_ERROR.notAllowed`; or a user-side one (`BoardCaller.side`), at board scope. With
   * no token, on a connection that never presented one, it acts as the user, at board scope. A target
   * outside its scope (`OrchestrateScope`), or an agent itself, is `BOARD_ERROR.outOfScope`. Each spawn, send,
   * interrupt, restart and close is logged, done or refused (`orchestrator.activity`).
   *
   * `spawn` starts an agent as `agent.spawn` does, in a zone of its scope (its own zone by default), with
   * `spawnedBy` the orchestrator agent (none for the user's side, whose agents are the user's). A prompt (and a `send`'s text) is refused with `invalidParams` when
   * `orchestratorTextRefusal` says why. With `baseBranch`, also when the base's project config (`.claude`, `.mcp.json`,
   * `.codex`) differs from the repo's HEAD: the agent would start under settings the orchestrator chose.
   */
  'orchestrator.spawn': { params: { token?: string } & OrchestratorSpawnParams; result: OrchestratorSpawned };
  /**
   * Sends `text` as the agent's next message (`agent.answer`). Only to a live agent at its prompt, between turns: one
   * that is working, needs permission or has ended is refused with `invalidParams`, and so is one whose Enter never
   * started a turn, the message left typed at its prompt (`Agent.unsent`), saying so. Instead of `text`, `submit`
   * presses Enter on the agent's unsent message (`agent.sendUnsent`) and `clear` clears it (`agent.clearUnsent`), both
   * refused while the user is typing there, and never on a reply path: only an orchestrator that may steer the agent
   * reaches its prompt so. Answers with how it went (`SendDelivery`).
   */
  'orchestrator.send': { params: { token?: string; sessionId: string; text?: string; submit?: boolean; clear?: boolean }; result: OrchestratorSent };
  /**
   * Sets the status line of an agent in the caller's crew (the agents it started, and theirs), as the agent's own
   * `board.setStatus` does, saying who set it. The latest of the two wins. An agent outside its crew, an orchestrator
   * of wider scope or the caller itself is refused with `outOfScope`.
   */
  'orchestrator.setStatus': { params: { token?: string; sessionId: string; summary?: string; progress?: number; character?: CharacterSet } & WorkCategoryParams; result: Agent };
  /**
   * Waits until every agent (or, with `any`, one) is in one of `states` (`SETTLED_STATES` by default), or `timeoutMs`
   * passes (`DEFAULT_ORCHESTRATOR_WAIT_MS`, at most `MAX_ORCHESTRATOR_WAIT_MS`). An agent sent a message or started
   * with a prompt by an orchestrator counts only once that turn has begun, so a wait straight after a send isn't
   * answered by the idle before it. An agent deleted meanwhile fails it with `invalidParams`. `finished` waits for
   * `Agent.workFinishedAt`; an agent its idle prompt moved from idle to waiting still counts as idle.
   *
   * With `crew`, it waits on the caller's crew too (the agents it started, and theirs; every agent for the user's side),
   * as it is at each check, and `sessionIds` may be left out. With `since` (a `cursor` from before, `now`, or `all` for
   * every one kept), it waits instead for the crew events after it of those agents (of `kinds`, or every kind) and
   * answers with them as soon as there is one. An event reaches the crew its agent was in as it happened, so a
   * removed agent's end still does. Each agent named is scope-checked as for `orchestrator.read`.
   */
  'orchestrator.wait': {
    params: {
      token?: string;
      sessionIds?: string[];
      crew?: boolean;
      states?: WaitState[];
      any?: boolean;
      since?: string;
      kinds?: CrewEventKind[];
      timeoutMs?: number;
    };
    result: OrchestratorWaitResult;
  };
  /**
   * The agent's final message from its last finished turn, or with `path` a text file in its worktree (relative to it,
   * and inside it once links are followed; at most `MAX_ORCHESTRATOR_READ_BYTES`). Fails with `invalidParams` when there
   * is none.
   */
  'orchestrator.read': { params: { token?: string; sessionId: string; path?: string }; result: OrchestratorReadResult };
  /** Interrupts the agent's turn (`agent.interrupt`). */
  'orchestrator.interrupt': { params: { token?: string; sessionId: string }; result: Agent };
  /**
   * Sets the agent's reasoning effort (`agent.setEffort`, as the tile's Reasoning menu does), and resolves with when it
   * takes it: now, once its turn ends, or when next started.
   */
  'orchestrator.setEffort': { params: { token?: string; sessionId: string; effort: Effort }; result: { agent: Agent; applies: EffortApplies } };
  /** Resumes a rate-limited agent's turn on usage credits (`agent.continueOnCredits`). */
  'orchestrator.continueOnCredits': { params: { token?: string; sessionId: string }; result: Agent };
  /**
   * Starts an ended agent again in place, as the tile's Restart does (`agent.resume`): the same tile, worktree and
   * branch, carrying on its conversation (Claude `--resume`, `codex resume`). Never forced: while the shell its pane
   * dropped into runs something it fails with `AGENT_ERROR.shellBusy`, for the user to end. With `fresh` it starts a
   * new conversation instead (a new harness session id in the same tile, worktree and branch; the old one is kept in
   * `Agent.earlierConversations`), on `prompt` if given, which an orchestrator may type like a `send`. `prompt` needs `fresh`.
   */
  'orchestrator.restart': { params: { token?: string; sessionId: string; fresh?: boolean; prompt?: string }; result: Agent };
  /**
   * Ends the agent's session, keeping its tile, worktree and branch (`agent.stop`); with `remove`, deletes it with its
   * worktree and branch (`agent.delete`, never forced, so `AGENT_ERROR.unsavedWork` stands), which only an agent the
   * orchestrator started may be. Resolves with the agent, or null once removed.
   */
  'orchestrator.close': { params: { token?: string; sessionId: string; remove?: boolean }; result: Agent | null };
  /**
   * Hands the orchestrator `from`'s crew (the agents it started) and what it made (notes, lane labels, clocks, shapes,
   * connectors, zones and edges) to the orchestrator `to`, as if `to` had started and made them: `to` may then arrange,
   * edit, remove and close them. The user's side hands over any; an orchestrator hands over its own, or takes over one in
   * its scope, no wider than its own, whose session has ended. Either way `to`'s own scope must reach every agent it
   * gets. `to` must be an orchestrator no deeper in a crew than `from`.
   */
  'orchestrator.handover': { params: { token?: string; from: string; to: string }; result: OrchestratorHandover };
  /** Pauses the agent, as `agent.pause` does, marked as paused by the orchestrator. */
  'orchestrator.pause': { params: { token?: string; sessionId: string }; result: Agent };
  /** Wakes a paused agent, carrying on its conversation (`agent.resume`). Fails with `invalidParams` for one not paused. */
  'orchestrator.wake': { params: { token?: string; sessionId: string }; result: Agent };
  /**
   * Makes a flow edge between two agents in its scope, or itself, marked as made by it (`FlowEdge.madeBy`),
   * as `flowEdge.create` makes one. Its `from` end must be one it may look at, and its `to` end one it may steer (an
   * edge into another orchestrator would steer it). A gate or script condition runs nothing until the user approves it
   * (ADR-0009): an orchestrator can't.
   */
  'orchestrator.addEdge': { params: { token?: string } & OrchestratorEdgeParams; result: FlowEdge };
  /** Deletes a flow edge it, or an agent in its crew, made; a user-side caller any. The user's are the user's. */
  'orchestrator.removeEdge': { params: { token?: string; id: string }; result: null };
  /**
   * Moves a tile (an agent's, a shell's, or a board item) in its scope to `place` (`LayoutPlace`), as the board's drag
   * does (`agent.move`, `shell.move`, `item.update`): clear of every other tile and item, by the board's placing rules,
   * its zone growing to hold it. Into a zone in its scope, or one it made; loose on the board only at board scope. An
   * agent may move itself: where a tile sits changes nothing about its session. It never moves an agent into a zone
   * that would let it orchestrate where it can't now.
   */
  'orchestrator.move': { params: { token?: string; target: LayoutTarget } & LayoutPlace; result: LayoutMoved };
  /**
   * Lays out the tiles in a zone in its scope (its own by default) that it may move: itself first, then a lane per
   * issue (or a row per role, or state), each agent beside the ones its edges join it to (`board-arrange.ts`). What it
   * may not move (other tiles, notes, cards) stays put, and the rows keep clear of it; the zone then fits what it holds,
   * growing or shrinking. The same board arranges the same way.
   */
  'orchestrator.arrange': { params: { token?: string; zoneId?: string; by?: ArrangeBy; layout?: ArrangeLayout; auto?: boolean }; result: ArrangeResult };
  /** Lays out the whole board: its zones and its loose tiles, never what is in a zone. Board scope only. */
  'orchestrator.arrangeBoard': { params: { token?: string }; result: BoardArrangeResult };
  /**
   * A zone in its scope (its own by default) as a map: its lanes, where everything is and what is amiss
   * (`ZoneMap`). It moves nothing.
   */
  'orchestrator.map': { params: { token?: string; zoneId?: string }; result: ZoneMap };
  /**
   * The app saying how it draws the board now (`LayoutMeasured`), from its window in front, a moment after what it
   * draws changes: every box drawn other than saved, every agent note's height for its text, and the tiles expanded as
   * it drew them. Each call replaces the last; they are kept in memory only, until the connection closes. Only the
   * connection that serves captures (the app's) may call it. Arrange and the zone map prefer them to estimates.
   */
  'layout.measured': { params: LayoutMeasured; result: null };
  /**
   * A picture of a zone in its scope (its own by default), as a PNG (`ZoneScreenshot`): the board as the app draws it
   * (`board`, with every terminal's text hidden), or a plain drawing of the boxes and lines the daemon knows (`lofi`).
   * The app takes it in a hidden window, never moving the user's view. Fails at once with no app open to take it, and
   * after `captureTimeoutMs` with none handed back.
   */
  'orchestrator.screenshot': { params: { token?: string; zoneId?: string; style?: CaptureStyle }; result: ZoneScreenshot };
  /**
   * Makes a group (an unbound zone) marked as made by it, as `zone.addUnbound` does: at `x`, `y` if given (stepped right
   * past any zone or loose tile there, as a new zone is), else beside its own zone; at `DEFAULT_ZONE_SIZE` without a
   * size. No zone in a zone: it never lands inside another.
   */
  'orchestrator.addZone': {
    params: { token?: string; name: string; color?: string; x?: number; y?: number; width?: number; height?: number };
    result: Zone;
  };
  /**
   * Renames, recolours, moves or resizes a group it (or its crew) made; a user-side caller any group. Shrinking past its
   * tiles moves only the ones its edge cuts through, as the board's resize does (`packTiles`), and is refused when they
   * have nowhere to go; it never moves onto another zone.
   */
  'orchestrator.changeZone': {
    params: { token?: string; id: string; name?: string; color?: string; x?: number; y?: number; width?: number; height?: number };
    result: Zone;
  };
  /** Deletes a group it (or its crew) made, as the board's Delete does (`zone.dissolve`): its tiles and notes stay, loose. */
  'orchestrator.removeZone': { params: { token?: string; id: string }; result: null };
  /**
   * Sets how a zone in its scope (its own by default) lays out what it holds (`Zone.layoutMode`), as the zone's Layout
   * menu does: the agent's way to opt a zone into shelves or clusters, or back to free. Moves no tile's saved place.
   */
  'orchestrator.zoneLayout': { params: { token?: string; zoneId?: string; mode: ZoneLayoutMode }; result: Zone };
  /**
   * Puts a sticky note (or a text item) of `text` on the board, marked as made by it, at `place` (`LayoutPlace`; in its
   * own zone by default), clear of the tiles and items there, in a zone in its scope or one it made.
   */
  'orchestrator.addNote': { params: { token?: string; text: string; kind?: NoteKind; color?: string } & LayoutPlace; result: BoardItem };
  /** Changes the text or colour of a note it (or its crew) made; a user-side caller any sticky note or text item. */
  'orchestrator.editNote': { params: { token?: string; id: string; text?: string; color?: string; width?: number; height?: number }; result: BoardItem };
  /** Deletes a note it (or its crew) made; a user-side caller any sticky note or text item. */
  'orchestrator.removeNote': { params: { token?: string; id: string }; result: null };
  /**
   * Puts a shape of `shape` with `text` in it on the board (a class's `attributes` and `methods`, a line each, under its
   * name), marked as made by it, placed as `addNote` places a note. It is sized for its text; the board grows it taller
   * if it needs more.
   */
  'orchestrator.addShape': { params: { token?: string } & DiagramShapeFields & { shape: ShapeType; text: string } & LayoutPlace; result: BoardItem };
  /**
   * Draws the Mermaid flowchart or class diagram `mermaid` on the board, each shape and connector marked as made by it:
   * laid out in ranks as Mermaid draws it, and placed as one block where `addNote` places a note. `skipped` is the
   * lines it passed over (styling, notes, and what it could not read).
   */
  'orchestrator.addDiagram': { params: { token?: string; mermaid: string } & LayoutPlace; result: { items: BoardItem[]; connectors: Connector[]; skipped: string[] } };
  /** Changes a shape it (or its crew) made: only the fields given; a user-side caller any shape. */
  'orchestrator.editShape': { params: { token?: string; id: string } & DiagramShapeFields; result: BoardItem };
  /** Deletes a shape it (or its crew) made, and with it every connector joined to it; a user-side caller any shape. */
  'orchestrator.removeShape': { params: { token?: string; id: string }; result: null };
  /**
   * Joins two board items with a connector, marked as made by it: `from` to `to` as `relation` reads (a child to its
   * parent, a whole to its parts), its sides picked from where the two are. Both in zones it may lay out.
   */
  'orchestrator.connect': { params: { token?: string; from: string; to: string } & DiagramConnectorFields; result: Connector };
  /** Changes a connector it (or its crew) made: only the fields given; a user-side caller any connector. */
  'orchestrator.editConnector': { params: { token?: string; id: string } & DiagramConnectorFields; result: Connector };
  /** Deletes a connector it (or its crew) made; a user-side caller any connector. */
  'orchestrator.removeConnector': { params: { token?: string; id: string }; result: null };
  /**
   * Puts a clock on the board (`ClockData` over a new clock's), marked as made by it: one that messages an agent in its
   * scope goes on that agent's tile's left; one that starts a fresh agent goes in a zone in its scope (`zoneId`, its own
   * by default). A hand-off's agent must be in its scope too.
   */
  'orchestrator.addClock': { params: { token?: string; data: Partial<ClockData>; zoneId?: string; template?: string }; result: BoardItem };
  /** Deletes a clock it (or its crew) made; a user-side caller any. */
  'orchestrator.removeClock': { params: { token?: string; id: string }; result: null };
  /** The app's default roles, by name. */
  'orchestrator.roles': { params: { token?: string }; result: DefaultRole[] };
  /**
   * Sets the app's default role `name` (a custom role's name, as `parseRole` reads it), replacing one of the same name
   * in any case; with `zoneId`, that zone's template for the name instead. The app's list is a board-scope
   * orchestrator's (or the user's side's) alone, and a zone must be in the caller's scope: else `outOfScope`. Fails
   * with `invalidParams` for a built-in role, a bad name, a body over `MAX_ROLE_TEMPLATE_LENGTH`, or one
   * `orchestratorTextRefusal` refuses: it starts other agents' first messages.
   */
  'orchestrator.setRole': { params: { token?: string; name: string; body: string; zoneId?: string }; result: DefaultRole };
  /**
   * Removes the app's default role `name` (read as `setRole` reads it), or with `zoneId` that zone's template for it,
   * scoped as `setRole`. Fails with `invalidParams` when there is none.
   */
  'orchestrator.removeRole': { params: { token?: string; name: string; zoneId?: string }; result: null };
  /**
   * The app's crew prefab library, for every board: the built-ins first, then those saved, by name; and any saved one
   * this release can't read, by name with why, to remove or import again.
   */
  'orchestrator.prefabs': { params: { token?: string }; result: { prefabs: LibraryPrefab[]; unreadable: { name: string; reason: string }[] } };
  /**
   * Saves a crew prefab from its `.crew.json` file's text, checked as `parsePrefab` reads it, to the app's library.
   * A name a prefab already has, in any case, is refused unless `replace`; a built-in's always (save a copy under a
   * name of its own). The library reaches every board, so it is a board-scope orchestrator's (or the user's side's)
   * alone: else `outOfScope`.
   */
  'orchestrator.savePrefab': { params: { token?: string; text: string; replace?: boolean }; result: LibraryPrefab };
  /** Removes a saved crew prefab, scoped as `savePrefab`. A built-in can't be removed; one with no such name fails. */
  'orchestrator.removePrefab': { params: { token?: string; name: string }; result: null };
  /**
   * Starts a crew from the prefab `name`: the member that starts on the prompt (its builder, or its lead) gets
   * `prompt`, in `zoneId` (the caller's zone without), as `orchestrator.spawn` starts an agent, scope and logs
   * included. A lead's first message lists its crew, for it to start. The members that start at the hand-off are
   * listed in `later`, and the crew (`crew`) starts them at each of its builder's hand-offs. A prefab with a lead needs
   * two free levels of crew depth. `roundLimit` replaces the prefab's for this crew alone (the prompt box's Stop after).
   */
  'orchestrator.startPrefab': {
    params: { token?: string; name: string; prompt?: string; zoneId?: string; repo?: string; issueId?: string; roundLimit?: number };
    result: PrefabStarted;
  };
  /** The running crews the caller reaches (by their builders), newest first; the one `crewId` names alone if given. */
  'orchestrator.crews': { params: { token?: string; crewId?: string }; result: Crew[] };
  /** Stops a crew's loop: no more reviewers start and no reviews go back. Its agents are left as they are. */
  'orchestrator.stopCrew': { params: { token?: string; crewId: string }; result: Crew };
  /**
   * One more round for a crew stopped at its round limit: its limit goes up by one and the round's reviews go back to
   * its builder, as any other round's.
   */
  'orchestrator.crewRound': { params: { token?: string; crewId: string }; result: Crew };
  /**
   * The orchestrators' activity log, newest first: `orchestratorId`'s alone if given, at most `limit`
   * (`DEFAULT_ACTIVITY_LIMIT`) lines, older than the line `before` (an id) if given, for the page after one read. Every
   * connection reads every line.
   */
  'orchestrator.activity': { params: { orchestratorId?: string; limit?: number; before?: number }; result: OrchestratorActivity[] };
  /**
   * Who holds `token`, a session's board token (`AGENT_BOARD_IDENTITY`, ADR-0010). Fails with `BOARD_ERROR.unknownToken`
   * for a token no live session holds. Once it answers, the connection is that session's: it may call only
   * `BOARD_CALLER_METHODS` from then on.
   */
  'board.identify': { params: { token: string }; result: BoardCaller };
  /**
   * Sets the status of the agent holding `token`: only its own. `summary` is trimmed and at most `MAX_STATUS_LENGTH`;
   * `progress` a whole number 0-100, or absent. Fails with `BOARD_ERROR.unknownToken` for an unknown token, and
   * `invalidParams` for a shell's, a blank summary or a bad progress. Makes the connection the session's, as
   * `board.identify` does. With `done`, it also says its work is finished (`Agent.workFinishedAt`). With `character`, it
   * sets the pose its character strikes (`Agent.character`), refusing a word outside its list with the list.
   * With `category`, it sets its work category whole (`Agent.workCategory`, ADR-0024), with a `label` and, for the two
   * that wait on others, a `waitingOn`; `none` clears it. `done` with no category is Done. Any of the three may be left
   * out, but not all.
   */
  'board.setStatus': { params: { token: string; summary?: string; progress?: number; done?: boolean; character?: CharacterSet } & WorkCategoryParams; result: Agent };
  /**
   * Records an entry on the sidebar of the agent holding `token` (`Agent.records`): a pull request by its GitHub URL,
   * with its title if known, or a hand-off doc by its path (relative to where the session started, or absolute), which
   * must be a file. With `forOrchestrator`, the doc goes on the orchestrator that started it instead, saying who
   * recorded it. Recording an entry again replaces it, and brings it back if the user deleted it. Fails with
   * `invalidParams` for a shell's token, a URL that names no pull request, a missing file, or `forOrchestrator` from an
   * agent no orchestrator started.
   */
  'board.record': { params: { token: string } & RecordParams; result: AgentRecord };
  /**
   * Takes a pin off the sidebar of the agent holding `token`, or with `forOrchestrator`, one it pinned there off its
   * orchestrator's (never the orchestrator's own, nor another crew member's). The record is gone, not deleted as the
   * user's delete leaves it. A file is named as `board.record` names it, even once it is gone; a note by its label.
   * Fails with `invalidParams` when there is no such pin.
   */
  'board.unpin': { params: { token: string } & PinRef; result: AgentRecord };
  /**
   * Writes the page of the agent holding `token` (`Agent.page`), replacing the one it had: only its own, never its
   * orchestrator's. With `page` null, clears it. Its name is at most `MAX_PAGE_NAME` characters, its icons are from
   * `PAGE_ICONS` and its tones from `PAGE_TONES`; it has 1 to `MAX_PAGE_BLOCKS` blocks. Fails with `invalidParams` for
   * a shell's token, or a page past those, with a block of an unknown kind, or a link to no file or no web page.
   */
  'board.setPage': { params: { token: string; page: PageParams | null }; result: AgentPage | null };
  /**
   * The agent holding `token` flags that it wants a look (`Agent.flag`): blocked, its work ready for review, or a
   * decision needed. `reason` is one line, at most `MAX_FLAG_LENGTH`; it replaces any flag it had. A crew member's flag
   * goes to its live orchestrator: typed at that one's prompt once it is there, and heard as a `flagged` crew event.
   * `via` names, for an orchestrator's flag, the crew member it passes on. With `clear`, it drops its flag instead.
   * Only a live agent, from its own session. Fails as `board.setStatus` does.
   */
  'board.needsYou': { params: { token: string; reason?: string; via?: string; clear?: boolean }; result: Agent };
  /**
   * The agent holding `token` hands `payload` over its own outgoing edges, or with `to` over its edge to that
   * agent alone, each as its auto hand-off would go: its conditions checked first, held while any fails, skipped while
   * paused. A manual edge is left for the user to send. Resolves with how it went along each edge, once each is
   * delivered, held, queued or skipped, or after a few seconds of checking. Fails with `invalidParams` for a caller that
   * isn't a live agent's own session, no edge out of it to `to`, or a bad payload. Each edge handed off along is
   * logged (`orchestrator.activity`). Its turn's end then hands off along the others alone. Handing off says its work is
   * finished (`Agent.workFinishedAt`): with no edge out of it and no `to`, that is all it does, and it resolves
   * with none.
   */
  'board.handoff': { params: { token: string; to?: string } & HandoffPayload; result: HandoffOutcome[] };
  /**
   * The live agent holding `token` asks the user `question`, with `options` as buttons and, with `freeText`
   * (always with no options), a reply field, and with `onBoard` put on the board at once, as a steps card beside its tile
   * that it waits on (`ask.toCard`). Resolves once the user answers or skips it, or after `timeoutMs`
   * (`DEFAULT_ASK_WAIT_MS`, at most `MAX_ASK_WAIT_MS`) with no answer. It goes, unanswered, when the connection closes
   * (the harness cancelled the call) or the agent's turn ends. Fails with `invalidParams` for a shell's token, a caller
   * that already asks or waits on a plan, or a bad question. A crew member's question goes to its live orchestrator
   * instead (`SentToOrchestrator`), at once.
   */
  'board.ask': {
    params: {
      token: string;
      question?: string;
      options?: string[];
      freeText?: boolean;
      /** Several questions (1 to `MAX_ASK_QUESTIONS`), stepped through, instead of `question`; each with its own options. */
      questions?: { question: string; options?: string[]; freeText?: boolean }[];
      onBoard?: boolean;
      timeoutMs?: number;
    };
    result: AskResult | SentToOrchestrator;
  };
  /**
   * The live agent holding `token` presents a plan, its next version, and waits for the user to approve it,
   * request changes or reject it, with comments. Kept in its history whatever happens. Resolves with the decision, or
   * `timed-out` after `timeoutMs` (`DEFAULT_PLAN_WAIT_MS`, at most `MAX_ASK_WAIT_MS`); `withdrawn` once the connection
   * closes or its turn ends. Fails as `board.ask` does, and for an empty or too long plan. A crew member's plan goes
   * to its live orchestrator instead (`SentToOrchestrator`), at once, written to `CREW_PLAN_PATH` in its worktree.
   * `path` is the real path of the file it was read from, if it was: the user's approved version is written there.
   * With `onBoard`, the agent's plan card is put beside its tile too, if it has none. With `detached` (the command line's
   * `doc --plan`) nothing waits: it answers at once with the plan (`PlanLeft`), which then outlives the connection and
   * the agent's turns, and its decision, or its timeout, is typed at the agent's prompt once it is ready for it.
   */
  'board.presentPlan': {
    params: { token: string; title: string; body: string; format: PlanFormat; path?: string; onBoard?: boolean; timeoutMs?: number; detached?: boolean };
    result: PlanResult | PlanLeft | SentToOrchestrator;
  };
  /**
   * Answers the agent's question `askId`, ending its wait. For an ask of several questions, answers its question `index`
   * (0 by default) and keeps waiting for `ask.send`, but a skip, which skips the whole ask. Fails with `invalidParams`
   * once it no longer asks it (answered, timed out or gone), once it is on the board (answered on its card), or for an
   * answer it doesn't take: an option it doesn't have, or words to a question without `freeText`.
   */
  'ask.answer': { params: SessionRef & { askId: string; answer: AskAnswer; index?: number }; result: null };
  /**
   * Sends the answers so far of the agent's ask `askId` of several questions, ending its wait: one left unanswered is
   * sent as skipped. Fails with `invalidParams` once it no longer asks it, or once it is on the board.
   */
  'ask.send': { params: SessionRef & { askId: string }; result: null };
  /**
   * Puts the agent's ask `askId` on the board as a steps card beside its tile, holding the answers so far. The agent's
   * call still waits, and the card's Send answers it. Resolves with the card. Fails with `invalidParams` once it no
   * longer asks it, or once it is on the board already.
   */
  'ask.toCard': { params: SessionRef & { askId: string }; result: BoardItem };
  /** The agent's plans, oldest first, with their bodies and decisions. */
  'plan.list': { params: SessionRef; result: Plan[] };
  /**
   * Decides the agent's plan `planId`, while it waits on it. Fails with `invalidParams` once it doesn't (decided, timed
   * out or withdrawn).
   */
  'plan.decide': { params: SessionRef & { planId: string; outcome: PlanOutcome; comments?: string }; result: PlanSummary };
  /**
   * The user saves `body` as their own version of the Markdown plan `planId` the agent waits on: its next version, which
   * the agent then waits on, the decision applying to it. Fails with `invalidParams` once it doesn't wait on that plan,
   * for an HTML plan, and for an empty, too long or unchanged body.
   */
  'plan.edit': { params: SessionRef & { planId: string; body: string }; result: PlanSummary };
  /**
   * The live agent holding `token` shows the user one of its files, Markdown or HTML (by its extension), as a document:
   * a Document tab in its window, and with `onBoard` a card beside its tile too. `path` is absolute. Showing the same file
   * again shows the same document, a card added if asked for and none is there. Returns at once: nothing waits.
   */
  'board.showDoc': { params: { token: string; path: string; title?: string; onBoard?: boolean }; result: DocumentSummary };
  /**
   * The live agent holding `token` puts a steps card beside its tile: `steps` in order, at most `MAX_STEPS`, of which at
   * most `MAX_STEPS_QUESTIONS` are questions. Its questions are the user's to answer, or, for a crew member, its live
   * orchestrator's, which is flagged. Returns at once: nothing waits, and the answers are typed at the agent's prompt once
   * they are sent. Fails with `invalidParams` for a shell's token, an ended agent, or steps it can't take.
   */
  'board.newSteps': { params: { token: string; title: string; steps: StepDraft[] }; result: BoardItem };
  /**
   * The steps cards the agent holding `token` can read: in its zone, in a zone its orchestrator scope reaches, loose, or
   * ones it made, answers or is named on; with `id`, only that one (failing with `outOfScope` if it can't read it), and
   * with `mine` only those with a to-do of its not yet done.
   */
  'board.readSteps': { params: { token: string; id?: string; mine?: boolean }; result: BoardItem[] };
  /**
   * The agent holding `token` changes the steps card `id`: ticks (or with `undo` unticks) a to-do that names it, waits
   * on a step to be told at its prompt once it is done, adds steps to a card it made, answers a question of a set it
   * answers for (a crew member's), sends those answers, or closes a card it made. Fails with `outOfScope` for a card
   * or a step that isn't its to change, and `invalidParams` for a closed card or a change it can't take.
   */
  'board.updateSteps': { params: { token: string; id: string; change: StepsChange }; result: BoardItem };
  /**
   * The user answers the question `stepId` of the steps card `id`, or with null takes their answer back. Fails with
   * `invalidParams` for a set the user doesn't answer, a closed card, a to-do, or an answer the question can't take.
   */
  'steps.answer': { params: { id: string; stepId: string; answer: StepAnswer | null }; result: BoardItem };
  /**
   * The user ticks (or unticks) the to-do `stepId`, one that names the user. The agents waiting on it are told at their
   * prompt. Fails with `invalidParams` for a to-do that names an agent, a question, or a closed card.
   */
  'steps.tick': { params: { id: string; stepId: string; done: boolean }; result: BoardItem };
  /**
   * The user sends the answers of the steps card `id` to its maker, typed at its prompt once it is ready: the first time
   * every answer, then only what changed. Fails with `invalidParams` while a required question is unanswered, with nothing
   * new to send, for a set the user doesn't answer, and for one the user made.
   */
  'steps.send': { params: { id: string }; result: BoardItem };
  /** The live agent holding `token` puts a memory card beside its tile. Fails with `invalidParams` for a shell's token or an ended agent. */
  'board.newMemory': { params: { token: string; title: string }; result: BoardItem };
  /** The memories the agent holding `token` reads: in its zone, in zones its orchestrator scope reaches, and loose ones; none set to No agents. */
  'board.listMemories': { params: { token: string }; result: BoardItem[] };
  /**
   * The memory `id` with its entries, pinned first, then newest first; with `search`, only those whose key or text holds it
   * (any case); with `entry` (a key, or an id or its start), only that one. Fails with `outOfScope` for one the agent
   * doesn't read.
   */
  'board.readMemory': { params: { token: string; id: string; search?: string; entry?: string }; result: MemoryView };
  /** The agent holding `token` changes the memory `id`: any entry, whoever wrote it. Fails with `outOfScope` as `board.readMemory` does. */
  'board.changeMemory': { params: { token: string; id: string; change: MemoryChange }; result: { item: BoardItem; entry: MemoryEntry | null } };
  /** The versions of the memory's entry `entry` (a key, or an id or its start), newest first. */
  'board.memoryHistory': { params: { token: string; id: string; entry: string }; result: HistoryVersion<MemoryEntry>[] };
  /** The live agent holding `token` puts a queue card beside its tile, for agents to take from or, with `audience: 'user'`, for the user. */
  'board.newQueue': { params: { token: string; title: string; audience?: QueueAudience }; result: BoardItem };
  /** The queues the agent holding `token` reads, as `board.listMemories` has its memories. */
  'board.listQueues': { params: { token: string }; result: BoardItem[] };
  /** The queue `id` with its jobs and notes, in order: open ones, then done ones, newest done first. */
  'board.readQueue': { params: { token: string; id: string }; result: QueueView };
  /**
   * The agent holding `token` changes the queue `id`: adds, edits or removes a job or note, takes a job (a lease its
   * session holds until done, dropped, or its session ends), drops one it took, or marks one it took done. Fails with
   * `outOfScope` for a queue it doesn't read, a job another agent holds, or taking from the user's queue.
   */
  'board.changeQueue': { params: { token: string; id: string; change: QueueChange }; result: { item: BoardItem; job: QueueJob | null } };
  /**
   * The orchestrator holding `token` turns the drain of a queue it made on or off: the board starts fresh agents (as an
   * earlier drain of it was set, else its own harness; `most` at once) for its waiting jobs. Fails with `notAllowed` for
   * an agent that doesn't orchestrate, and `outOfScope` for a queue another made.
   */
  'board.drainQueue': { params: { token: string; id: string; on: boolean; most?: number }; result: BoardItem };
  /** The versions of the queue's job `job`, newest first. */
  'board.queueHistory': { params: { token: string; id: string; job: string }; result: HistoryVersion<QueueJob>[] };
  /**
   * Adds lines for the user to the caller's to-do list, one a text, making the list under its tile if it has none.
   * Nothing waits on them and no one is told when they are ticked.
   */
  'board.remind': { params: { token: string; text: string[] }; result: { item: BoardItem; added: TodoLine[] } };
  /** The to-do lists the caller reads (in its zone, zones its scope reaches, and loose ones); with `mine`, only its own. */
  'board.readTodos': { params: { token: string; mine?: boolean }; result: BoardItem[] };
  /** The caller ticks, unticks or takes off a line it wrote on its own list. */
  'board.changeTodo': { params: { token: string; change: AgentTodoChange }; result: BoardItem };
  /** The memory `id` with its entries, for the user, as `board.readMemory` has them. */
  'memory.read': { params: { id: string; search?: string; entry?: string }; result: MemoryView };
  /** The user changes the memory `id`, as `board.changeMemory` does. */
  'memory.change': { params: { id: string; change: MemoryChange }; result: { item: BoardItem; entry: MemoryEntry | null } };
  /** The versions of an entry, for the user. */
  'memory.history': { params: { id: string; entry: string }; result: HistoryVersion<MemoryEntry>[] };
  /** The queue `id` with its jobs, for the user. */
  'queue.read': { params: { id: string }; result: QueueView };
  /** The user changes the queue `id`: as an agent does, except that the user takes nothing, and drops or finishes any job. */
  'queue.change': { params: { id: string; change: QueueChange }; result: { item: BoardItem; job: QueueJob | null } };
  /** The versions of a job, for the user. */
  'queue.history': { params: { id: string; job: string }; result: HistoryVersion<QueueJob>[] };
  /** The user changes the to-do list `id`: any line on it, whoever wrote it. */
  'todo.change': { params: { id: string; change: TodoChange }; result: BoardItem };
  /**
   * The user hands the queue `id`'s waiting job `job` to the idle agent `sessionId` in its scope: the job is taken for
   * that agent, and `text` (what the user chose to send, nothing added) is typed at its prompt as the user's message.
   * If the message can't be sent, the job stays waiting.
   */
  'queue.hand': { params: { id: string; job: string; sessionId: string; text: string }; result: { item: BoardItem; job: QueueJob } };
  /** Every job taken now, across the board's queues, with its queue: for the takers' tiles to show. */
  'queue.taken': { params: undefined; result: TakenJob[] };
  /** The document with its text as the file holds it now, line breaks as `\n`. Fails with `invalidParams` for an unknown document. */
  'doc.read': { params: { documentId: string }; result: DocumentContent };
  /**
   * The user saves `text` over a Markdown document: written to its file in the file's own line breaks, and its agent
   * told what changed, typed at its prompt once it is ready for its next message. Fails with `invalidParams` for a
   * document that isn't `editable`, a file gone or made a link since it was shown, and, unless `force`, when the file
   * changed since `baseVersion`, the version the user edited.
   */
  'doc.save': { params: { documentId: string; text: string; baseVersion: number; force?: boolean }; result: DocumentSummary };
  /** The user's comments on a document, typed at its agent's prompt as `doc.save`'s changes are. */
  'doc.comment': { params: { documentId: string; text: string }; result: null };
  /**
   * Moves the agent's tile within its zone, into any other (another repo's, or an unbound one) or out onto the board
   * (`zoneId` null). Only its tile moves. Fails with `invalidParams` for an unknown zone or agent.
   */
  'agent.move': { params: SessionRef & TileMove; result: Agent };
  /**
   * Every external session agent-board has heard of and not dismissed, live or ended, oldest first. Only reads: the
   * Unsorted group is made when a session first appears, at daemon start, and when a zone change leaves one with no
   * zone (`zone.unbind`, `zone.remove`, `zone.dissolve`), never here.
   */
  'external.list': { params: undefined; result: ExternalSession[] };
  /** Takes an external session off the board. It comes back if its session reports again. */
  'external.dismiss': { params: { id: string }; result: null };
  /**
   * Moves the session's tile within its zone, into any other, or out onto the board (`zoneId` null). Only its tile
   * moves. Fails with `invalidParams` for an unknown session or zone.
   */
  'external.move': { params: { id: string } & TileMove; result: ExternalSession };
  /** What resuming the session in agent-board would mean, for the user to confirm: where, and whether it is safe. */
  'external.resumePlan': { params: { id: string }; result: ExternalResumePlan };
  /**
   * Resumes the session in agent-board, adopting it as an agent with the same session id (Claude with `--resume`, Codex
   * with `codex resume`, or afresh if it can't) in a terminal of `cols` x `rows`. Its tile takes the external tile's
   * place (`position` for one the board slotted into its zone), and its connectors; the external session goes.
   * Fails with `AGENT_ERROR.liveElsewhere` while it may still be running elsewhere, unless `force`, and with
   * `invalidParams` when its folder is gone (for `here`), or it is outside git (for `new-worktree`).
   */
  'external.resume': {
    params: { id: string; where: ExternalResumeWhere; force?: boolean; position?: { x: number; y: number } } & TerminalSize;
    result: Agent;
  };
  /** Whether the global hooks are installed in `~/.claude/settings.json` and `~/.codex/hooks.json`. */
  'externalHooks.status': { params: undefined; result: ExternalHooksStatus };
  /**
   * Installs the global hooks for every harness, or takes them out, beside the user's own hooks. Fails with
   * `invalidParams`, changing nothing, if a hook file isn't valid JSON.
   */
  'externalHooks.setEnabled': { params: { enabled: boolean }; result: ExternalHooksStatus };
  /**
   * Checks a CLI the way onboarding shows it: `claude` and `codex` on the PATH agents start with, `gh` as the trackers
   * run it. Runs its `--version` and its sign-in status; never anything that spends tokens.
   */
  'setup.check': { params: { tool: SetupTool }; result: ToolCheck };
  /** The value the app last saved under `key` (`view.set`), or null. */
  'view.get': { params: { key: string }; result: unknown };
  /**
   * Saves how the app left the board under `key` (1 to 64 characters), such as its viewport: any JSON value up to
   * 64 KiB, kept across restarts. Null forgets the key.
   */
  'view.set': { params: { key: string; value: unknown }; result: null };
  /** Every board item, lowest `z` first. */
  'item.list': { params: undefined; result: BoardItem[] };
  /** Adds an item on top of the others. Fails with `invalidParams` for an unknown kind or zone, or a size under 1. */
  'item.create': { params: CreateItemParams; result: BoardItem };
  /** Changes an item. Fails with `invalidParams` for an unknown item or zone, or a size under 1. */
  'item.update': { params: UpdateItemParams; result: BoardItem };
  /** Fails with `invalidParams` for an unknown item. */
  'item.delete': { params: { id: string }; result: null };
  /** Every clock's status. */
  'clock.list': { params: undefined; result: ClockStatus[] };
  /**
   * Adds a clock (`ClockData`, filled in from `template`, by id or name, then from defaults) at `place`: beside an agent's
   * tile, on its left in its zone, or where asked. Fails with `invalidParams` for an unknown agent, zone or template, or
   * data a clock can't have.
   */
  'clock.add': { params: { data: Partial<ClockData>; place: ClockPlace; template?: string }; result: BoardItem };
  /**
   * The caller changes its own clock: the one that messages it, or whose run started it. `result` says what it does
   * now. Fails with `invalidParams` for a caller with no clock, or more than one and none named, and for a clock that
   * isn't its own.
   */
  'clock.self': { params: ClockSelfParams; result: { clock: BoardItem; said: string } };
  /**
   * The caller adds a clock of its own: one that messages it with `prompt` on `cron`, beside its tile, hibernating it
   * after each run or leaving it idle. Fails with `invalidParams` for a cron or prompt a clock can't have.
   */
  'clock.addSelf': { params: { token?: string; cron?: string; prompt?: string; after?: 'hibernate' | 'idle'; template?: string }; result: BoardItem };
  /** Every saved clock template, by name. */
  'clockTemplate.list': { params: { token?: string } | undefined; result: ClockTemplate[] };
  /**
   * Saves a template under `name`, replacing the one of that name (whatever its case). An agent saves as itself, and
   * can't replace another's. Fails with `invalidParams` for data a clock can't have, or an unknown `fromClock`.
   */
  'clockTemplate.save': { params: ClockTemplateSaveParams; result: ClockTemplate };
  /** Removes a template, by id or name: an agent only one it saved. */
  'clockTemplate.remove': { params: { token?: string; template: string }; result: null };
  /** Every connector. */
  'connector.list': { params: undefined; result: Connector[] };
  /** Fails with `invalidParams` for an end that doesn't exist, both ends the same, or a value that isn't allowed. */
  'connector.create': { params: CreateConnectorParams; result: Connector };
  /** Fails with `invalidParams` for an unknown connector or a value that isn't allowed. */
  'connector.update': { params: UpdateConnectorParams; result: Connector };
  /** Fails with `invalidParams` for an unknown connector. */
  'connector.delete': { params: { id: string }; result: null };
  /** Every flow edge. */
  'flowEdge.list': { params: undefined; result: FlowEdge[] };
  /**
   * Fails with `invalidParams` for an agent that doesn't exist, both ends the same, an edge already joining them the
   * same way, or an auto edge that would close a loop of auto edges (agents answering each other for ever).
   */
  'flowEdge.create': { params: CreateFlowEdgeParams; result: FlowEdge };
  /**
   * Changes its rules, its shape, or the agent at an end. Fails as `flowEdge.create` does for an end moved onto
   * itself, an unknown agent or a pair already joined that way, or an auto edge that would close a loop, and with
   * `invalidParams` for a path outside the worktree or a condition missing its command or label. A held hand-off is
   * checked again at once.
   */
  'flowEdge.update': { params: UpdateFlowEdgeParams; result: FlowEdge };
  /** Fails with `invalidParams` for an unknown flow edge. */
  'flowEdge.delete': { params: { id: string }; result: null };
  /**
   * Delivers the edge's payload now, whatever its conditions say, dropping any hand-off it holds: its `from` agent's
   * final message, from the turn it last finished, or its file as it is now. Resolves with the edge and how it went.
   * Fails with `invalidParams` for an unknown edge, or a payload it can't read (no final message, no such file).
   */
  'flowEdge.send': { params: { id: string }; result: FlowEdgeSent };
  /** What the edge would carry now. Fails with `invalidParams` for an unknown edge. */
  'flowEdge.preview': { params: { id: string }; result: FlowPayloadPreview };
  /** What each gate's or script's command on the edge runs now, and whether you approved it. */
  'flowEdge.commands': { params: { id: string }; result: FlowCommandApproval[] };
  /**
   * Approves what one of the edge's commands runs, as `flowEdge.commands` showed it, checking its held hand-off again.
   * Fails with `invalidParams` for a command not on the edge, or one that has changed since (its fingerprint differs).
   * The approval is bound to the edge's sender session and its worktree: it fails if the sender is not `from` (the one
   * the user looked at it for, if given), or changes while it is checked, and holds only while the edge has that sender.
   */
  'flowEdge.approve': { params: { id: string; command: string; fingerprint: string; from?: string }; result: FlowEdge };
  /** Drops the hand-off the edge holds and the delivery it queued, and any copy of them. */
  'flowEdge.drop': { params: { id: string }; result: FlowEdge };
  /** What the edge last delivered, while the daemon remembers it; null before its first delivery, or since a restart. */
  'flowEdge.lastPayload': { params: { id: string }; result: FlowDeliveredPayload | null };
  'settings.get': { params: undefined; result: DaemonSettings };
  /** Changes the settings given. Keeping only paths drops the copies held now. */
  'settings.set': { params: Partial<DaemonSettings>; result: DaemonSettings };
  /** The newest plan usage reading. */
  'usage.get': { params: { token?: string } | undefined; result: UsageReading };
  /** Every implementer's review rounds, by implementer and round. */
  'review.list': { params: undefined; result: ReviewRound[] };
  /**
   * Starts the implementer's next review round: spawns a reviewer on a branch from its branch's tip, in its harness,
   * told to review its diff and reply with the review doc only. Fails with `invalidParams` for an unknown agent, a
   * reviewer, an implementer with a round still under review, or one that has had its `reviewCap` rounds.
   */
  'review.start': { params: { sessionId: string } & Partial<TerminalSize>; result: ReviewRound };
  /**
   * Sends the round's doc to its implementer as its next message, headed as a hand-off from its reviewer, relaunching
   * an ended implementer. Fails with `invalidParams` for a round with no doc, or when the implementer can't take it now
   * (it is still working, or waiting for you), saying why.
   */
  'review.send': { params: { id: string }; result: ReviewRound };
  /** Dismisses the round: deletes its reviewer and that one's worktree, keeping the doc. */
  'review.dismiss': { params: { id: string }; result: ReviewRound };
  /**
   * Squash-merges the implementer's open pull request with gh. Only from its latest round, once that approves with no
   * open blocker, and the PR's checks pass (or it has none); fails with `invalidParams` saying which isn't so.
   */
  'review.merge': { params: { id: string }; result: Agent };
  /** Sets how many review rounds the implementer may have, 1 to `MAX_REVIEW_CAP`. */
  'review.setCap': { params: { sessionId: string; cap: number }; result: Agent };
  /**
   * Reads a pull request whole for its PR tab with gh: its description, checks, changed files with
   * their diffs, reviews and comments, and whether the user may merge or approve it. Fails with
   * `TRACKER_ERROR.unavailable` when GitHub can't be reached or its rate limit is reached, `TRACKER_ERROR.unauthorized`
   * when gh isn't logged in, and `invalidParams` for anything GitHub refuses, such as an unknown pull request.
   */
  'pullRequest.details': { params: PullRequestRef; result: PullRequestDetails };
  /**
   * Approves the pull request as the gh user at `headCommit`, the commit the user saw, refusing with `invalidParams` if
   * its head has moved on since; then reads it again. Fails as `pullRequest.details` does.
   */
  'pullRequest.approve': { params: PullRequestRef & { headCommit: string }; result: PullRequestActed };
  /**
   * Squash-merges the pull request while its head is still `headCommit`, the commit the user saw, so nothing pushed
   * since is merged; then reads it again. One a merge gate guards (`gatedBy`) whose gate hasn't passed on `headCommit`
   * is refused with `invalidParams` unless `pastGate`, the user's confirmation that they merge past it.
   * Fails as `pullRequest.details` does.
   */
  'pullRequest.merge': { params: PullRequestRef & { headCommit: string; pastGate?: boolean }; result: PullRequestActed };
  /** Every agent's latest merge gate run, one per agent that has run its gate. */
  'gate.list': { params: undefined; result: GateRun[] };
  /**
   * What the agent's gate buttons need: its latest run, its zone's gate command, the commit its worktree is at (null
   * when it has none, or its worktree is gone), and how many files there are uncommitted. Fails with `invalidParams` for
   * an unknown agent.
   */
  'gate.status': { params: SessionRef; result: GateStatus };
  /**
   * Runs the gate command of the zone of the agent's repo in its worktree, through `sh -c`, in a process group
   * of its own, replacing its last run; resolves as it starts, and `gate.updated` follows its steps (ADR-0013). The
   * user's alone, never an agent's. Fails with `invalidParams` for an unknown agent, one whose zone has no gate command,
   * one whose worktree is gone or has no commit, or one whose gate is already running.
   */
  'gate.run': { params: SessionRef; result: GateRun };
  /** Stops the agent's gate, its whole process group; the run ends `stopped`. Nothing happens if none is running. */
  'gate.stop': { params: SessionRef; result: null };
  /**
   * A piece of the agent's latest run's log, kept under the data dir per agent and commit: a step's (its own lines, or
   * the file it named), or with no `step` the whole output. From byte `since` on, else the last part; `next` is where to
   * read on from. Fails with `invalidParams` for an agent that has no run, or a step it hasn't.
   */
  'gate.log': { params: SessionRef & { step?: string; since?: number }; result: GateLog };
  /**
   * Opens a pull request of the agent's branch: pushes it, then has gh make one, titled after its issue
   * (or its name), described from the repo's pull request template filled from its worktree's `.agent-board/handover.md`
   * with the gate table (in a zone with a gate), and `Fixes` its issue. It pushes the commit checked, not whatever the
   * branch is at by then. Fails with `invalidParams` when anything is uncommitted, when in a zone with a gate the gate hasn't
   * passed on its head (`openPullRequestBlocked`), when the worktree isn't on its branch, or when it has an open pull
   * request already.
   */
  'gate.openPullRequest': { params: SessionRef; result: PullRequest };
  /**
   * The agent whose tile holds `token` opens a pull request of its own branch as `gate.openPullRequest` does, always as
   * a draft: marking it ready, running the gate and merging stay the user's. Fails with `invalidParams` for any
   * token but an agent's own session's (a shell's is the user's, who has Open PR), and as `gate.openPullRequest` does.
   */
  'board.openPullRequest': { params: { token: string }; result: PullRequest };
  /**
   * Squash-merges the agent's pull request `number` while its head is `headCommit`, only if GitHub's checks
   * are green and, in a zone with a gate command, its gate passed on that commit (`mergeBlocked`, checked again here),
   * then cleans up as `cleanup` says: its worktree and branch only while the worktree is still at `headCommit` with nothing
   * uncommitted, so no work that wasn't merged is lost.
   * Fails with `invalidParams` saying why when it may not merge; once merged, a clean-up step that fails is reported in
   * `GateMerged.failed`, never as a failure.
   */
  'gate.merge': { params: SessionRef & { number: number; headCommit: string; cleanup: GateCleanup }; result: GateMerged };
  /**
   * Pastes the failing step's last lines at the agent's prompt as one bracketed paste, sending nothing: checked
   * as it writes, so never into a pending permission prompt, nor an agent that has ended. Fails with `invalidParams` then,
   * and for an agent whose latest run didn't fail at `step`.
   */
  'gate.sendFailure': { params: SessionRef & { step: string }; result: null };
  /**
   * Takes the image file at `path` into the image store, content-addressed, and resolves with its reference for an
   * image item. The file must be in the data dir's `images/incoming` folder; it is moved away. A copy already stored
   * is kept once. Fails with `invalidParams` for a file over `MAX_IMAGE_BYTES` or not a PNG, JPEG, GIF or WebP.
   */
  'image.import': { params: { path: string }; result: ImageRef };
  /**
   * Takes the file at `path` as `image.import` does, checked the same, and keeps a copy in `PASTED_IMAGES_DIR` for an
   * agent to read; resolves with where.
   */
  'image.paste': { params: { path: string }; result: { path: string } };
  /**
   * Ask Claude about a selection: keeps its picture and diagram in a folder of their own, starts an agent with them in
   * its first message, and once its first turn finishes puts its final message on the board as an agent note at
   * `note`, joined to the selection by an arrow, with any suggested edits on it. Never sent unless the user asks. Fails
   * with `invalidParams` for a picture that isn't a PNG in `images/incoming`, or a diagram too large to send.
   */
  'selection.ask': { params: AskSelectionParams; result: Agent };
  /**
   * The Captain (ADR-0019): the board's master, live or ended, or, with none, starts one at `board` scope, loose on
   * the board left of the zones, in a folder of its own with no repo, with the master's prompt as its first message.
   * The app's alone: a board token's connection is refused it.
   */
  'master.start': { params: StartMasterParams; result: Agent };
  'tracker.status': { params: { provider: TrackerProvider }; result: TrackerStatus };
  /**
   * Checks the credential (an API key or OAuth token) with the tracker, then keeps it in the OS keychain, never in
   * the database. Resolves with the scopes it can see. Fails with `TRACKER_ERROR.unauthorized` if refused, and with
   * `invalidParams` for GitHub, which uses gh's own login and never has a credential.
   */
  'tracker.connect': { params: { provider: TrackerProvider; credential: string }; result: TrackerScope[] };
  /** Deletes the tracker's credential from the keychain. Zones keep their tracker settings. */
  'tracker.disconnect': { params: { provider: TrackerProvider }; result: null };
  /**
   * The teams (or repos) the tracker's credential can see. For GitHub, the 100 repos most recently pushed to; a zone
   * can be bound to any other repo gh can see.
   */
  'tracker.scopes': { params: { provider: TrackerProvider }; result: TrackerScope[] };
  /**
   * The scope's open projects, most recently updated first, for a tracker that has them (Linear). `invalidParams` for
   * one that has none, and `TRACKER_ERROR.notConnected` before `tracker.connect`.
   */
  'tracker.projects': { params: { provider: TrackerProvider; scope: string }; result: TrackerProject[] };
  /**
   * The zone's open issues (its project's, if it has one), most recently updated first; or, with a non-blank `query`,
   * the issues matching it.
   */
  'tracker.issues': { params: { zoneId: string; query?: string }; result: TrackerIssue[] };
}

/** Error codes for agent methods, outside JSON-RPC's reserved range. */
export const AGENT_ERROR = {
  /** Deleting would lose work; ask the user, then retry with `force`. */
  unsavedWork: -32010,
  /**
   * The new worktree has Codex config of its own, so Codex will ask the user to review its hooks along with
   * agent-board's. The message says so; ask the user, then retry with `allowProjectCodexConfig`.
   */
  projectCodexConfig: -32011,
  /** The permission prompt was settled elsewhere or timed out; the agent's terminal may still ask. */
  permissionGone: -32012,
  /** The shell an ended agent's pane dropped into is running something; ask the user, then retry with `force`. */
  shellBusy: -32013,
  /** The external session may still be running in another terminal; ask the user, then retry with `force`. */
  liveElsewhere: -32014,
} as const;

/** Errors of the `board.*` methods, which the agent-facing CLI and MCP call (ADR-0010). */
export const BOARD_ERROR = {
  /** No live session holds the board token: it is wrong, or its session has ended. */
  unknownToken: -32020,
  /**
   * The connection presented a board token, and the method isn't one of `BOARD_CALLER_METHODS`; or it is an
   * orchestrator method, and the token's agent may not orchestrate.
   */
  notAllowed: -32021,
  /** An orchestrator acted on an agent or zone outside its scope, or on itself. */
  outOfScope: -32022,
} as const;

/**
 * What a connection that has presented a session's board token (`board.identify`, `board.setStatus`) may call: the
 * board's reads, its own status, records and hand-offs, and asking the user a question or presenting a plan (ADR-0014); nothing
 * that starts, steers, answers for or stops a session, or changes a setting (ADR-0010). A connection that never presents one is the user's, with the whole API.
 */
export const BOARD_CALLER_METHODS: ReadonlySet<DaemonMethod> = new Set<DaemonMethod>([
  'daemon.health',
  'zone.list',
  'agent.list',
  'agent.starts',
  'agent.refreshBranches',
  'shell.list',
  'flowEdge.list',
  'item.list',
  'clock.list',
  // Only its own clock, which messages it or started it: its mode, or off (ADR-0017).
  'clock.self',
  'clock.addSelf',
  // Templates are shared by every zone; an agent removes only those it saved.
  'clockTemplate.list',
  'clockTemplate.save',
  'clockTemplate.remove',
  'connector.list',
  'board.identify',
  'board.setStatus',
  'board.record',
  'board.unpin',
  'board.setPage',
  'board.needsYou',
  'board.handoff',
  'board.ask',
  'board.presentPlan',
  'board.showDoc',
  'board.newSteps',
  'board.readSteps',
  'board.updateSteps',
  'board.newMemory',
  'board.listMemories',
  'board.readMemory',
  'board.changeMemory',
  'board.memoryHistory',
  'board.newQueue',
  'board.listQueues',
  'board.readQueue',
  'board.changeQueue',
  'board.queueHistory',
  'board.remind',
  'board.readTodos',
  'board.changeTodo',
  'board.openPullRequest',
  'orchestrator.activity',
  'usage.get',
]);

/**
 * The orchestrator methods (ADR-0011): a board token's connection reaches them too, and each refuses unless the
 * token's agent may orchestrate, checked at every call.
 */
export const ORCHESTRATOR_METHODS: ReadonlySet<DaemonMethod> = new Set<DaemonMethod>([
  // A queue's drain starts agents: only an orchestrator turns on its own (ADR-0011), as the maintainer's answer 10 has it.
  'board.drainQueue',
  'orchestrator.spawn',
  'orchestrator.send',
  'orchestrator.setStatus',
  'orchestrator.wait',
  'orchestrator.read',
  'orchestrator.interrupt',
  'orchestrator.setEffort',
  'orchestrator.continueOnCredits',
  'orchestrator.restart',
  'orchestrator.pause',
  'orchestrator.wake',
  'orchestrator.close',
  'orchestrator.handover',
  'orchestrator.addEdge',
  'orchestrator.removeEdge',
  'orchestrator.move',
  'orchestrator.arrange',
  'orchestrator.arrangeBoard',
  'orchestrator.map',
  'orchestrator.screenshot',
  'orchestrator.addZone',
  'orchestrator.changeZone',
  'orchestrator.removeZone',
  'orchestrator.zoneLayout',
  'orchestrator.addNote',
  'orchestrator.editNote',
  'orchestrator.removeNote',
  'orchestrator.addShape',
  'orchestrator.addDiagram',
  'orchestrator.editShape',
  'orchestrator.removeShape',
  'orchestrator.connect',
  'orchestrator.editConnector',
  'orchestrator.removeConnector',
  'orchestrator.addClock',
  'orchestrator.removeClock',
  'orchestrator.roles',
  'orchestrator.setRole',
  'orchestrator.removeRole',
  'orchestrator.prefabs',
  'orchestrator.savePrefab',
  'orchestrator.removePrefab',
  'orchestrator.startPrefab',
  'orchestrator.crews',
  'orchestrator.stopCrew',
  'orchestrator.crewRound',
]);

/**
 * What a user-side session's connection (`BoardCaller.side`) may call beyond those: turning an agent's
 * orchestrating on and off. The daemon refuses an agent's own session it. A zone's switch, like every setting, stays the
 * app's.
 */
export const USER_SIDE_METHODS: ReadonlySet<DaemonMethod> = new Set<DaemonMethod>(['agent.setOrchestrate']);

/** Most of a file `orchestrator.read` returns. */
export const MAX_ORCHESTRATOR_READ_BYTES = 256 * 1024;

/** Lines `orchestrator.activity` returns without a limit, and at most. */
export const DEFAULT_ACTIVITY_LIMIT = 100;
export const MAX_ACTIVITY_LIMIT = 1_000;

/** Whether `value` is a status's progress: a whole percentage, 0 to 100. */
export function isStatusProgress(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
}

/** A status as one line: `Moving session ids to the daemon · 40%`. */
export function statusLine(status: Pick<AgentStatus, 'summary' | 'progress'>): string {
  return status.progress === null ? status.summary : `${status.summary} · ${status.progress}%`;
}

/**
 * What an approve or merge answers once it is done: the pull request as it is now, or, when reading it
 * again failed, why: the action itself still happened.
 */
export type PullRequestActed = { details: PullRequestDetails } | { readError: string };

/** What `gate.status` answers. */
export interface GateStatus {
  run: GateRun | null;
  command: string | null;
  head: string | null;
  /** The branch the worktree has checked out, or null for a detached HEAD (or no worktree). */
  branch: string | null;
  uncommitted: number;
}

/** A piece of a gate log (`gate.log`). */
export interface GateLog {
  text: string;
  /** The byte to read on from. */
  next: number;
  /** Set when `since` was past the log's end, as when the run started again: `text` is from its start. */
  reset?: true;
}


/** What `gate.merge` answers once merged: each clean-up step done, and each that failed with why. */
export interface GateMerged {
  done: (keyof GateCleanup)[];
  failed: { step: keyof GateCleanup; why: string }[];
}

/** Sent to every client when an agent's gate run starts, a step of it starts or ends, or it ends. */
export interface GateUpdatedEvent {
  type: 'gate.updated';
  run: GateRun;
}

/**
 * Error codes for tracker calls. A tracker refusing a request for a reason of its own (an unknown issue or team) is
 * `invalidParams`.
 */
export const TRACKER_ERROR = {
  /** The tracker has no credential yet: ask for one and `tracker.connect`. */
  notConnected: -32020,
  /** The tracker refused the credential. */
  unauthorized: -32021,
  /** The tracker could not be reached. */
  unavailable: -32022,
} as const;

export type DaemonMethod = keyof DaemonMethods;

/** A harness hook call that passed token auth, attributed to its session. */
export interface HookEvent {
  type: 'hook';
  sessionId: string;
  /** The payload's `hook_event_name`, e.g. `Stop`. */
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Sent to a client when it attaches, or catches up after falling behind: the session's scrollback and screen, as
 * terminal output that redraws them on a reset terminal. A large snapshot continues in the `session.output` events
 * that follow it.
 */
export interface SessionSnapshotEvent {
  type: 'session.snapshot';
  sessionId: string;
  data: string;
  cols: number;
  rows: number;
}

/** Terminal output, sent to the clients attached to the session. */
export interface SessionOutputEvent {
  type: 'session.output';
  sessionId: string;
  data: string;
}

/** Sent to every client when a session's process ends. */
export interface SessionExitedEvent {
  type: 'session.exited';
  sessionId: string;
  session: SessionInfo;
}

/** Sent to every client when an agent is spawned or changes: its state, its subagents or its end. */
export interface AgentUpdatedEvent {
  type: 'agent.updated';
  agent: Agent;
}

/**
 * Sent to every client when the transcript of an agent whose conversation a client has read (`agent.transcript`) is
 * written to, so its chat reads what it gained at once.
 */
export interface AgentTranscriptChangedEvent {
  type: 'agent.transcriptChanged';
  sessionId: string;
}

/** Sent to every client when an agent's start begins or changes (`AgentStart`): a step, its name, or its failure. */
export interface AgentStartingEvent {
  type: 'agent.starting';
  start: AgentStart;
}

/** Sent to every client when a start is over: its agent's session runs (its `agent.updated` came first), or it was dismissed. */
export interface AgentStartEndedEvent {
  type: 'agent.startEnded';
  sessionId: string;
}

/** Sent to every client when a setting changes (`settings.set`), with all of them as they are now. */
export interface SettingsUpdatedEvent {
  type: 'settings.updated';
  settings: DaemonSettings;
}

/** Sent to every client when a newer usage reading comes in, or the last one goes stale. */
export interface UsageUpdatedEvent {
  type: 'usage.updated';
  usage: UsageReading;
}

/** Sent to every client when an agent is deleted. */
export interface AgentRemovedEvent {
  type: 'agent.removed';
  sessionId: string;
}

/** Sent to every client as each line is added to the orchestrators' activity log. */
export interface OrchestratorActivityEvent {
  type: 'orchestrator.activity';
  entry: OrchestratorActivity;
}

/** Sent to every client when an external session first reports, or changes: its state, status file or end. */
export interface ExternalUpdatedEvent {
  type: 'external.updated';
  session: ExternalSession;
}

/** Sent to every client when an external session is dismissed. */
export interface ExternalRemovedEvent {
  type: 'external.removed';
  id: string;
}

/** Sent to every client when a board item is created or changed. */
export interface ItemUpdatedEvent {
  type: 'item.updated';
  item: BoardItem;
}

/** Sent to every client when a board item is deleted. */
export interface ItemRemovedEvent {
  type: 'item.removed';
  id: string;
}

/** Sent to every client when a clock is planned again or fires, or a run of it ends. */
export interface ClockUpdatedEvent {
  type: 'clock.updated';
  status: ClockStatus;
}

/** Sent to every client when a clock template is saved, new or replaced: only that one. */
export interface ClockTemplateUpdatedEvent {
  type: 'clockTemplate.updated';
  template: ClockTemplate;
}

/** Sent to every client when a clock template is removed. */
export interface ClockTemplateRemovedEvent {
  type: 'clockTemplate.removed';
  id: string;
}


/** Sent to every client when a connector is created or changed. */
export interface ConnectorUpdatedEvent {
  type: 'connector.updated';
  connector: Connector;
}

/**
 * Sent to every client when a connector is deleted by `connector.delete`. One that goes with an object at its end isn't
 * announced: clients drop it as they hear the object go.
 */
export interface ConnectorRemovedEvent {
  type: 'connector.removed';
  id: string;
}

/** Sent to every client when a flow edge is created or changes, a delivery included. */
export interface FlowEdgeUpdatedEvent {
  type: 'flowEdge.updated';
  edge: FlowEdge;
}

/**
 * Sent to every client when a flow edge is deleted by `flowEdge.delete`. One that goes with an agent at its end isn't
 * announced: clients drop it as they hear the agent go.
 */
export interface FlowEdgeRemovedEvent {
  type: 'flowEdge.removed';
  id: string;
}

/**
 * Sent to every client when a review round starts or changes: its doc came, it failed, was sent or dismissed. Rounds
 * that go with their implementer aren't announced: clients drop them as they hear it go.
 */
export interface ReviewUpdatedEvent {
  type: 'review.updated';
  round: ReviewRound;
}

/** Sent to every client when a zone is added or changes, such as how far its clone is. */
export interface ZoneUpdatedEvent {
  type: 'zone.updated';
  zone: Zone;
  /** Why its clone failed, when it did and the zone was kept, unbound. */
  cloneFailed?: string;
}

/** Sent to every client when a zone is removed. */
export interface ZoneRemovedEvent {
  type: 'zone.removed';
  id: string;
  /** Why its clone failed, when the zone went because it did. Unset when the clone was cancelled. */
  cloneFailed?: string;
}

/** Sent to every client when a shell tile is created or changes: a split, a resize, a closed or ended pane. */
export interface ShellUpdatedEvent {
  type: 'shell.updated';
  shell: Shell;
}

/**
 * Sent to every client when a window's layout changes other than by the window itself (slice 4): a tab moved
 * into or out of it from another window (`shell.moveSurface`). Null once a tab window has no tab left.
 */
export interface WindowLayoutEvent {
  type: 'window.layout';
  owner: WindowOwner;
  layout: WindowLayout | null;
}

/** How a zone's picture is drawn: as the board draws it, or plainly from the boxes and lines the daemon knows. */
export const CAPTURE_STYLES = ['board', 'lofi'] as const;
export type CaptureStyle = (typeof CAPTURE_STYLES)[number];

/** The longest side of a zone's picture, px: a bigger zone is drawn smaller, at `ZoneScreenshot.scale`. */
export const MAX_CAPTURE_SIDE = 1568;

/** The board round a zone its picture takes in too, px a side: room for the zone's tab above it, and its edge. */
export const CAPTURE_MARGIN = 40;

/**
 * The most a zone's PNG may take, in bytes: under the 5 MB a model's API takes an image at, with room to spare. The app
 * draws a picture over it smaller until it fits, and says so in its size.
 */
export const MAX_CAPTURE_PNG_BYTES = 3_500_000;

/** A zone's picture, as `orchestrator.screenshot` answers. */
export interface ZoneScreenshot {
  zoneId: string;
  style: CaptureStyle;
  /** The PNG, as base64. */
  png: string;
  /** The picture's size, px. */
  width: number;
  height: number;
  /**
   * Picture px per board px: 1, or less for a zone (with its `CAPTURE_MARGIN`) bigger than `MAX_CAPTURE_SIDE`, or whose
   * picture the app drew smaller to keep it under `MAX_CAPTURE_PNG_BYTES`.
   */
  scale: number;
  /** The zone as `orchestrator.map` maps it, taken as the picture was asked for: its size, and its lint. */
  map: ZoneMap;
}

/**
 * Sent to the connection that serves captures (`capture.serve`) alone: draw `rect` (a zone's and its `CAPTURE_MARGIN`, in board px) at `scale`
 * and hand it back with `capture.deliver`, or `capture.fail`. For `lofi`, `svg` is the whole drawing.
 */
export interface CaptureRequestedEvent {
  type: 'capture.requested';
  id: string;
  zoneId: string;
  style: CaptureStyle;
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
  svg?: string;
  /** When the daemon stops waiting, ms since the epoch: a picture not handed back by then is no use. */
  deadline: number;
}

/** A picture handed back for a `capture.requested`. */
export interface CaptureDelivery {
  id: string;
  /** The PNG, as base64. */
  png: string;
  width: number;
  height: number;
}

/** Sent to every client when a shell tile is removed. */
export interface ShellRemovedEvent {
  type: 'shell.removed';
  shellId: string;
}


export type DaemonEvent =
  | ZoneUpdatedEvent
  | ZoneRemovedEvent
  | ItemUpdatedEvent
  | ItemRemovedEvent
  | ClockUpdatedEvent
  | ClockTemplateUpdatedEvent
  | ClockTemplateRemovedEvent
  | ConnectorUpdatedEvent
  | ConnectorRemovedEvent
  | FlowEdgeUpdatedEvent
  | FlowEdgeRemovedEvent
  | ReviewUpdatedEvent
  | GateUpdatedEvent
  | ShellUpdatedEvent
  | ShellRemovedEvent
  | WindowLayoutEvent
  | ExternalUpdatedEvent
  | ExternalRemovedEvent
  | HookEvent
  | SessionSnapshotEvent
  | SessionOutputEvent
  | SessionExitedEvent
  | AgentUpdatedEvent
  | AgentRemovedEvent
  | AgentTranscriptChangedEvent
  | AgentStartingEvent
  | AgentStartEndedEvent
  | SettingsUpdatedEvent
  | UsageUpdatedEvent
  | OrchestratorActivityEvent
  | CaptureRequestedEvent;

export const EVENT_METHOD = 'event';

/** An event as the line the daemon pushes to a client. */
export function eventLine(event: DaemonEvent): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method: EVENT_METHOD, params: event })}\n`;
}

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** Longest line, in UTF-16 code units, either side accepts before dropping the connection. */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;

/**
 * Calls `onLine` for each complete line in a stream of chunks. Returns false once an unfinished line grows past
 * `maxLength`. Each chunk is scanned once and a partial line is kept as a list of pieces, so a long line costs O(n).
 */
export function lineSplitter(onLine: (line: string) => void, maxLength = MAX_LINE_LENGTH): (chunk: string) => boolean {
  let pieces: string[] = [];
  let pendingLength = 0;
  return (chunk) => {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf('\n', start)) >= 0) {
      pieces.push(chunk.slice(start, newline));
      const line = pieces.join('');
      pieces = [];
      pendingLength = 0;
      start = newline + 1;
      if (line.trim()) onLine(line);
    }
    if (start < chunk.length) {
      pieces.push(chunk.slice(start));
      pendingLength += chunk.length - start;
    }
    return pendingLength <= maxLength;
  };
}
