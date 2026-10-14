import type {
  ChecksState,
  PullRequest,
  PullRequestState,
  TrackerIssue,
  TrackerProject,
  TrackerScope,
} from '@agent-board/tracker';
import type { TrackerProvider } from '@agent-board/tracker/providers';
import pkg from '../package.json' with { type: 'json' };
import type { PaneLayout, SplitDirection } from './pane-layout.ts';

export type { PaneLayout, SplitDirection };
export type {
  ChecksState,
  PullRequest,
  PullRequestState,
  TrackerIssue,
  TrackerProject,
  TrackerProvider,
  TrackerScope,
};
// The provider table has no Node imports, so clients (the app's renderer) can use it too.
export { isTrackerProvider, shortIssueId, TRACKER_PROVIDERS } from '@agent-board/tracker/providers';
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

/** A build as people should quote it: `abc1234 · 2026-10-09`. */
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
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Whether its Codex agents start with `--dangerously-bypass-hook-trust` (ADR-0004), so agent-board's hooks run
   * without review. On by default. Off, Codex asks the user to review them once, in the agent's terminal.
   */
  codexBypassHookTrust: boolean;
  /** Where the zone's issues come from, or null if it has no tracker. */
  tracker: ZoneTracker | null;
  /** The clone it waits for, while the daemon clones its repo; null once it is bound, and for every other zone. */
  clone: ZoneClone | null;
  /**
   * An unbound zone's default repo: a repo's root, or a folder in one, that agents started in it without a
   * repo of their own are cut from, and its shells start in. Null for none, and for every bound zone.
   */
  defaultRepo: string | null;
  createdAt: string;
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
  /** Whether a zone on the board is bound to its local clone. */
  onBoard: boolean;
}

export type ZoneKind = 'repo' | 'folder' | 'unbound';

/**
 * How an unbound zone is bound: `repo` to an existing git repo, or a folder inside one; `project` to a new repo, made
 * by `git init` in an empty or new folder, with an empty first commit so worktrees can branch from it.
 */
export type ZoneBinding = 'repo' | 'project';

/** Zone tints, handed out least-used first so neighbouring zones differ. */
export const ZONE_COLORS = ['#4c6ef5', '#12b886', '#f59f00', '#e64980', '#7950f2', '#15aabf', '#fa5252', '#82c91e'];

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
};

/** A zone's settings. */
export interface ZoneSettings {
  codexBypassHookTrust: boolean;
}

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
 * How the board slots session tiles in a zone (`board/layout.ts` is the one that does it; its tests pin these): a
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

/** Where a zone sits on the board and how big it is. */
export interface ZoneLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The kinds of board item. Each is drawn by its own node type on the board. */
export const BOARD_ITEM_KINDS = ['sticky', 'text', 'shape', 'image', 'link', 'issue'] as const;
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
  /** What the kind needs, e.g. a sticky note's `StickyData`. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

/** A sticky note's `data`. */
export interface StickyData {
  /** Markdown: bold, italics, lists and links. */
  text: string;
  /** `#rrggbb`, one of the presets. */
  color: string;
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
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** The most characters a text item's, or a shape's, text may have. */
export const MAX_TEXT_LENGTH = 20_000;

/**
 * The colours text can be, the first by default. Stored in the item's data, so content rather than theme, like
 * `STICKY_COLORS`.
 */
export const TEXT_COLORS = [
  { name: 'Ink', value: '#2b2a27' },
  { name: 'Grey', value: '#6f6a60' },
  { name: 'Red', value: '#c92a2a' },
  { name: 'Orange', value: '#d9480f' },
  { name: 'Green', value: '#2f9e44' },
  { name: 'Blue', value: '#3b5bdb' },
  { name: 'Violet', value: '#6741d9' },
] as const;

/** A text item's `data`: free text with no background. */
export interface TextData {
  text: string;
  size: TextSize;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** `#rrggbb`. */
  color: string;
  /**
   * False while the text sizes its own width as it is typed; true once the user has resized it, when the width stays
   * and the text wraps.
   */
  wrap: boolean;
}

export const SHAPE_TYPES = ['rectangle', 'rounded', 'ellipse', 'diamond'] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** The fills a shape can have, the first by default. A shape may also have none (`fill` null). */
export const SHAPE_FILLS = [
  { name: 'Yellow', value: '#fff3bf' },
  { name: 'Green', value: '#d3f9d8' },
  { name: 'Blue', value: '#d0ebff' },
  { name: 'Pink', value: '#ffdeeb' },
  { name: 'White', value: '#ffffff' },
] as const;

/** The stroke colours a shape can have, the first by default. */
export const SHAPE_STROKES = [
  { name: 'Orange', value: '#d9480f' },
  { name: 'Ink', value: '#2b2a27' },
  { name: 'Blue', value: '#3b5bdb' },
  { name: 'Green', value: '#2f9e44' },
  { name: 'Red', value: '#c92a2a' },
  { name: 'Violet', value: '#6741d9' },
] as const;

/** The stroke widths of a shape, px; 0 is no outline. */
export const SHAPE_STROKE_WIDTHS = [1, 2.5, 4] as const;

/** A shape's `data`. Its text is centred in it. */
export interface ShapeData {
  shape: ShapeType;
  /** `#rrggbb`, or null for none. */
  fill: string | null;
  /** `#rrggbb`. */
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  text: string;
  textSize: TextSize;
  bold: boolean;
  /** `#rrggbb`. */
  textColor: string;
}

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
export const CONNECTOR_LINE_ENDS = ['none', 'arrow', 'dot'] as const;
export type ConnectorLineEnd = (typeof CONNECTOR_LINE_ENDS)[number];
/** The most characters a connector's label may have. */
export const MAX_CONNECTOR_LABEL = 500;

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
  /** `#rrggbb`, or null for the theme's neutral line. */
  color: string | null;
  /** The text on the middle of the line; empty for none. */
  label: string;
  createdAt: string;
  updatedAt: string;
}

/** What a connector is drawn as when made without a say in its look: a curved line, an arrow at `to`, the theme's neutral. */
export const DEFAULT_CONNECTOR_LOOK = {
  style: 'curved',
  startEnd: 'none',
  endEnd: 'arrow',
  color: null,
  label: '',
} as const satisfies Pick<Connector, 'style' | 'startEnd' | 'endEnd' | 'color' | 'label'>;

/**
 * A new connector. A client may pick its `id` (letters, digits and `-`, at most 64), so it can show the connector before
 * the daemon answers. What is left out is the default: a curved line with an arrow at `to`, in the theme's neutral.
 */
export interface CreateConnectorParams {
  id?: string;
  from: ConnectorEnd;
  to: ConnectorEnd;
  style?: ConnectorStyle;
  startEnd?: ConnectorLineEnd;
  endEnd?: ConnectorLineEnd;
  color?: string | null;
  label?: string;
}

/** A change to a connector's look or label: only the fields given change. Its ends are fixed; delete and draw anew. */
export type UpdateConnectorParams = { id: string } & Partial<
  Pick<Connector, 'style' | 'startEnd' | 'endEnd' | 'color' | 'label'>
>;

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
export interface FlowEdge {
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
  createdAt: string;
  updatedAt: string;
}

/** How many of an edge's events it lists. */
export const FLOW_EDGE_HISTORY = 20;

/**
 * A new flow edge: `final-message`, `auto` and no conditions unless given; a file payload's `path` is its default
 * unless given. A client may pick its `id`, as for a connector, and does to make one again on redo.
 */
export interface CreateFlowEdgeParams {
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
 * A change to an edge's rules: only the fields given change. Changing its payload resets its path unless one is given.
 * A hand-off it holds is dropped when its payload changes or it is made manual; one it queued, when it is made to
 * deliver as a message.
 */
export interface UpdateFlowEdgeParams {
  id: string;
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

/** The settings the daemon keeps and acts on. */
export interface DaemonSettings {
  heldPayloads: HeldPayloadStorage;
}

/** What an edge would carry if its `from` agent handed off now: its name (`plan.md`) and text, or why it can't. */
export type FlowPayloadPreview = { name: string; text: string; bytes: number } | { name: string; problem: string };

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
}

/** The agent CLI a session runs. */
export type Harness = 'claude' | 'codex';

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
 * An agent with an enabled schedule is never `stopped-by-restart`: its schedule relaunches it. `handing-off` is a
 * live agent delivering its payload along its flow edges, whatever its hooks say, until every delivery has landed.
 */
export const AGENT_STATES = [...SESSION_STATES, 'scheduled', 'stopped-by-restart', 'handing-off'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** States an agent is mid-turn in: the only ones `agent.interrupt` accepts. */
export const INTERRUPTIBLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'needs-permission']);

/**
 * Whether an agent waits for the user: live, and waiting for input or needing permission, or with any permission
 * prompt pending. The app's needs-you inbox holds these, and the daemon's start banner counts them.
 */
export function waitsForYou(agent: Pick<Agent, 'endedAt' | 'state' | 'permissions'>): boolean {
  return agent.endedAt === null && (agent.state === 'waiting' || agent.state === 'needs-permission' || agent.permissions.length > 0);
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
  /** The role it was started in, or null for none. */
  role: AgentRole | null;
  name: string;
  /**
   * What it is working on: the task it was started with. For an agent started from an issue, the typed task, else the
   * issue's description.
   */
  description: string;
  /** Its branch; '' for an external session resumed outside git, or on a detached HEAD, in its own folder. */
  branch: string;
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
  /** The tracker issue it works on, or null. */
  issue: LinkedIssue | null;
  /** Whether the user muted its OS notifications. It still counts in the needs-you inbox. */
  muted: boolean;
  /**
   * The GitHub pull requests made from its branch, newest first, with their state and checks: as last seen by the
   * daemon, which asks gh every minute or so. Empty when the repo is not on GitHub.
   */
  pullRequests: PullRequest[];
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
  /** The subagents it has spawned that are still running, or finished a moment ago; oldest first. */
  subagents: Subagent[];
  /**
   * What it last said to the user, the context for answering it: its final message from the turn it last finished
   * (`Stop`), or the message of a mid-turn request for input. Null before then, and from each new prompt until then.
   */
  lastMessage: string | null;
  /**
   * The tool calls, its own or its subagents', waiting for the user's permission, oldest first. While any is, the
   * agent is `needs-permission`.
   */
  permissions: PermissionPrompt[];
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
}

/**
 * A long-lived agent's cron schedule. At each fire time the daemon starts a run: it sends `prompt` to the agent as its
 * next message, relaunching the agent first if its session has ended. A fire time at which the agent is still
 * working, rate-limited, waiting for you, or has a draft typed at its prompt, is skipped. One after a failed turn runs.
 */
export interface AgentSchedule {
  /** Five fields (minute, hour, day of month, month, day of week) or a macro such as `@daily`, in the daemon's local time. */
  cron: string;
  prompt: string;
  enabled: boolean;
  /** When it next fires; null while disabled. */
  nextRunAt: string | null;
  /** The last time it fired, or null if it hasn't yet. */
  lastRun: ScheduleRun | null;
}

/** A schedule as the user sets it. */
export interface ScheduleSpec {
  cron: string;
  prompt: string;
  /** True by default. */
  enabled?: boolean;
}

/** One time a schedule fired: the run it started, or why it skipped. */
export interface ScheduleRun {
  /** The fire time it was due at. */
  dueAt: string;
  /** When it went off: later than `dueAt` if the machine slept through it. */
  firedAt: string;
  outcome: 'started' | 'skipped';
  /** Why it skipped, e.g. `it was still running`; null for a started run. */
  reason: string | null;
}

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
}

/** The user's answer to a permission prompt. A deny's `message` tells the agent why. */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

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

/**
 * One thing in an agent's conversation, as the chat view shows it, read from its harness's transcript by a
 * versioned adapter (`transcript-adapters.ts`). A tool's result is its own entry, joined to its call by `id`.
 */
export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  /** `input` is the call's arguments, or the raw text of a tool that takes free text (Codex's `exec`). */
  | { kind: 'tool-call'; id: string; name: string; input: unknown }
  /** `agentId` names the subagent a Claude Agent call ran, whose own transcript `agent.subagentTranscript` reads. */
  | { kind: 'tool-result'; id: string; output: string; isError: boolean; agentId?: string }
  /** A message between Codex agents: a task handed to a subagent (its text is encrypted, so empty) or its answer. */
  | { kind: 'subagent-message'; from: string; to: string; text: string }
  /** Something that happened to the turn, e.g. `Interrupted`. */
  | { kind: 'notice'; text: string };

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
  createdAt: string;
}

/**
 * Where a new agent's worktree is cut from when it is not its zone's repo: a git repo, or a folder in one, which the
 * agent then starts in; or a new scratch repo the daemon makes for it (`<scratch dir>/<agent name>`).
 */
export type AgentRepo = { path: string } | { scratch: true };

/**
 * The roles an agent can be started in: what its work is in a flow. Recorded and shown.
 */
export const AGENT_ROLES = ['implementer', 'reviewer', 'follow-up-reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Starts an agent in a new worktree, on a new branch, with `prompt` as its first task. Its repo is `repo` if given,
 * else its zone's (a bound zone's repo, or a group's default repo).
 */
export type SpawnAgentParams = TerminalSize & {
  /** The zone its tile starts in, or null for loose on the board (which needs `repo` and `position`). */
  zoneId: string | null;
  /** The repo to cut its worktree from, instead of its zone's. */
  repo?: AgentRepo;
  /** The branch to cut it from: the repo's HEAD without. */
  baseBranch?: string;
  /** Its new branch's name, which the repo must not have yet: made from its name (or issue) without. */
  branch?: string;
  /** `claude` by default. */
  harness?: Harness;
  /** The harness's model (`--model` for Claude, `-m` for Codex): its own default without. A name, never an option. */
  model?: string;
  /** Its role, none without. */
  role?: AgentRole;
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
  'session.attach': { params: SessionRef; result: null };
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
  /** Every shell tile, oldest first. */
  'shell.list': { params: undefined; result: Shell[] };
  /**
   * Starts a shell tile with one pane: in the zone, a shell in its folder, or loose on the board (`zoneId` null), a
   * shell in the home directory. `position` places its tile (relative to the zone), and is needed for a loose one.
   * Fails with `invalidParams` for an unknown zone.
   */
  'shell.create': { params: CreateShellTileParams; result: Shell };
  /**
   * Moves the shell's tile: within its zone, into another, or out onto the board (`zoneId` null). Its panes stay
   * where they are running. Fails with `invalidParams` for an unknown shell or zone.
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
   * and the tile went with it.
   */
  'shell.closePane': { params: { shellId: string; sessionId: string }; result: Shell | null };
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
  /** Ends every pane's session and removes the tile. */
  'shell.delete': { params: { shellId: string }; result: null };
  /** Every zone, oldest first. */
  'zone.list': { params: undefined; result: Zone[] };
  /**
   * Adds a zone for a folder picked by the user, at board position (x, y): a git root becomes a repo zone, a folder
   * inside a repo a folder zone. Fails with `invalidParams` if the folder is missing or not inside a git repo.
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
  /** The folders zones were made for, most recently first, while they are still folders in a git repo. At most 20. */
  'zone.recentFolders': { params: undefined; result: RecentFolder[] };
  /**
   * The GitHub repos gh can see, most recently pushed first, each with its local clone if the daemon knows one. Fails
   * as `tracker.scopes` does for GitHub.
   */
  'zone.githubRepos': { params: undefined; result: GitHubRepoSource[] };
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
   * Sets an unbound zone's default repo to the git repo (or folder in one) `path` is, or clears it with null. Fails with
   * `invalidParams` for an unknown or bound zone, or a `path` that is not absolute or not in a git repo.
   */
  'zone.setDefaultRepo': { params: { id: string; path: string | null }; result: Zone };
  /** Moves and resizes a zone. Fails with `invalidParams` for an unknown id or a size under `MIN_ZONE_SIZE`. */
  'zone.update': { params: { id: string } & ZoneLayout; result: Zone };
  /** Fails with `invalidParams` for an unknown id, or a zone that still has agents. */
  'zone.remove': { params: { id: string }; result: null };
  /**
   * Dissolves a group in one step: every tile of its (agents, shells, external sessions) is put loose on the board
   * where it is drawn, and the zone goes; its board items and connectors stay where they are. All or nothing. Fails
   * with `invalidParams` for an unknown id, a zone bound to a repo, or one still cloning.
   */
  'zone.dissolve': { params: { id: string }; result: null };
  /** Renames a zone and/or recolours it (`#rrggbb`). Fails with `invalidParams` for an unknown id, a blank name or a bad colour. */
  'zone.setLook': { params: { id: string; name?: string; color?: string }; result: Zone };
  /** Changes a zone's settings. Fails with `invalidParams` for an unknown id. */
  'zone.configure': { params: { id: string } & ZoneSettings; result: Zone };
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
  /** The name an agent started now with no task would get, the lowest free `new-agent-N`, for a picker to show. */
  'agent.nextName': { params: undefined; result: { name: string } };
  /** Every agent, running or ended, oldest first, with its current state. */
  'agent.list': { params: undefined; result: Agent[] };
  /**
   * Ends the agent's session and removes its worktree and branch. Fails with `AGENT_ERROR.unsavedWork` when the
   * worktree has uncommitted changes or the branch has commits no other branch has, unless `force`.
   */
  'agent.delete': { params: SessionRef & { force?: boolean }; result: null };
  /**
   * Sends `text` to the agent as the user's next message and submits it. One line is typed at its prompt; text of
   * several lines, or one line with `paste` (the composer sets it for a pasted image's path, as a dropped file is
   * pasted), goes as a bracketed paste, as a terminal pastes, so the harness keeps its line breaks. Control characters
   * other than tab and the line break are dropped either way. Answers to one agent go one at a time. Fails with
   * `invalidParams` for an unknown or ended agent, empty text, or an agent that needs permission (the text would land
   * in its permission dialog).
   */
  'agent.answer': { params: SessionRef & { text: string; paste?: boolean }; result: null };
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
   * Ends the agent's session and resolves with it `done` (not `failed`: the user stopped it). Its worktree and branch
   * stay. Fails with `invalidParams` for an unknown or ended agent.
   */
  'agent.stop': { params: SessionRef; result: Agent };
  /**
   * Starts an ended agent (`stopped-by-restart`, or one that exited) again in its worktree, carrying on its
   * conversation with no new prompt (Claude `--resume`, Codex `codex resume`, or a new Codex conversation if it can't).
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
   * Changes its rules. Fails as `flowEdge.create` does for an auto edge that would close a loop, and with
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
  'flowEdge.send': { params: { id: string }; result: FlowEdge };
  /** What the edge would carry now. Fails with `invalidParams` for an unknown edge. */
  'flowEdge.preview': { params: { id: string }; result: FlowPayloadPreview };
  /** What each gate's or script's command on the edge runs now, and whether you approved it. */
  'flowEdge.commands': { params: { id: string }; result: FlowCommandApproval[] };
  /**
   * Approves what one of the edge's commands runs, as `flowEdge.commands` showed it, checking its held hand-off again.
   * Fails with `invalidParams` for a command not on the edge, or one that has changed since (its fingerprint differs).
   */
  'flowEdge.approve': { params: { id: string; command: string; fingerprint: string }; result: FlowEdge };
  /** Drops the hand-off the edge holds and the delivery it queued, and any copy of them. */
  'flowEdge.drop': { params: { id: string }; result: FlowEdge };
  'settings.get': { params: undefined; result: DaemonSettings };
  /** Changes the settings given. Keeping only paths drops the copies held now. */
  'settings.set': { params: Partial<DaemonSettings>; result: DaemonSettings };
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

/** Sent to every client when an agent is deleted. */
export interface AgentRemovedEvent {
  type: 'agent.removed';
  sessionId: string;
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
  | ConnectorUpdatedEvent
  | ConnectorRemovedEvent
  | FlowEdgeUpdatedEvent
  | FlowEdgeRemovedEvent
  | ReviewUpdatedEvent
  | ShellUpdatedEvent
  | ShellRemovedEvent
  | ExternalUpdatedEvent
  | ExternalRemovedEvent
  | HookEvent
  | SessionSnapshotEvent
  | SessionOutputEvent
  | SessionExitedEvent
  | AgentUpdatedEvent
  | AgentRemovedEvent;

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
