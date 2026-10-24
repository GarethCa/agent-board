import type {
  Agent,
  AgentRecordKind,
  AgentRemovedEvent,
  AgentStart,
  AgentStartEndedEvent,
  AgentStartingEvent,
  AgentUpdatedEvent,
  BoardItem,
  BuildInfo,
  ClockData,
  ClockPlace,
  ClockStatus,
  ClockUpdatedEvent,
  Connector,
  ConnectorRemovedEvent,
  ConnectorUpdatedEvent,
  CreateConnectorParams,
  CreateFlowEdgeParams,
  DaemonSettings,
  SettingsUpdatedEvent,
  FlowCommandApproval,
  FlowEdge,
  FlowEdgeRemovedEvent,
  FlowEdgeUpdatedEvent,
  FlowDeliveredPayload,
  FlowPayloadPreview,
  RoleTemplate,
  CheckoutState,
  UpdateFlowEdgeParams,
  PullRequestActed,
  PullRequestDetails,
  PullRequestRef,
  ReviewRound,
  ReviewUpdatedEvent,
  CreateItemParams,
  ImageRef,
  CreateShellTileParams,
  DaemonHealth,
  ExternalHooksStatus,
  ExternalRemovedEvent,
  ExternalSession,
  ExternalResumePlan,
  ExternalResumeWhere,
  ExternalUpdatedEvent,
  ItemRemovedEvent,
  ItemUpdatedEvent,
  PermissionDecision,
  ScheduleSpec,
  SetupTool,
  SessionExitedEvent,
  SessionInfo,
  SessionOutputEvent,
  SessionSnapshotEvent,
  PackageScripts,
  ShellOwner,
  ShellPlace,
  WindowLayoutEvent,
  WindowOwner,
  PaneLayout,
  Shell,
  TileMove,
  TranscriptChunk,
  ToolCheck,
  ShellRemovedEvent,
  ShellUpdatedEvent,
  SpawnAgentParams,
  AskSelectionParams,
  StartMasterParams,
  SplitDirection,
  TerminalSize,
  TrackerIssue,
  TrackerProject,
  TrackerProvider,
  TrackerScope,
  TrackerStatus,
  UpdateConnectorParams,
  UpdateItemParams,
  GitHubRepoSource,
  NewZoneParams,
  CheckedFolder,
  RecentFolder,
  Zone,
  ZoneBinding,
  ZoneLayout,
  ZoneRemovedEvent,
  ZoneUpdatedEvent,
  ZoneSettings,
  ZoneSnapshot,
  ZoneTracker,
  OrchestratorActivity,
  OrchestratorActivityEvent,
  GateCleanup,
  GateLog,
  GateMerged,
  GateRun,
  GateStatus,
  GateUpdatedEvent,
  AskAnswer,
  Plan,
  PlanOutcome,
  PlanSummary,
  DocumentContent,
  DocumentSummary,
} from '@agent-board/daemon/protocol';
import type { Placement, Surface, WindowLayout } from '@agent-board/daemon/window-layout';
import type { Appearance } from '../shared/appearance';

/** The app lost its connection to the daemon for this attachment; the session itself may still be running. */
export interface SessionDetachedEvent {
  type: 'session.detached';
  sessionId: string;
}

/** The session could not be attached, e.g. because it has already ended. */
export interface SessionAttachFailedEvent {
  type: 'session.attachFailed';
  sessionId: string;
  message: string;
}

/** What a session window hears about the session it shows. */
export type SessionStreamEvent =
  | SessionSnapshotEvent
  | SessionOutputEvent
  | SessionExitedEvent
  | SessionDetachedEvent
  | SessionAttachFailedEvent;

/** The daemon and build IPC channels between the preload and main. */
export const DAEMON_IPC = {
  health: 'daemon:health',
  build: 'daemon:build',
  restart: 'daemon:restart',
} as const;

/** The outcome of restarting the daemon. */
export type RestartDaemonResult = { status: 'restarted' } | { status: 'sessions-live'; liveSessions: number };

/** The IPC channels between the preload and main. */
export const SESSION_IPC = {
  list: 'session:list',
  attach: 'session:attach',
  detach: 'session:detach',
  write: 'session:write',
  resize: 'session:resize',
  kill: 'session:kill',
  cwd: 'session:cwd',
  revealFolder: 'session:revealFolder',
  revealFile: 'session:revealFile',
  /** main → renderer: `(attachId, SessionStreamEvent)` for an attachment. */
  event: 'session:event',
  /** main → renderer: `(SessionExitedEvent)` for every session that ends. */
  exited: 'session:exited',
} as const;

export interface SessionsApi {
  /** Live sessions. */
  list(): Promise<SessionInfo[]>;
  /**
   * Streams the session: a snapshot of its scrollback and screen first, then its output, and its exit. Returns the
   * function that stops streaming; the session keeps running.
   */
  attach(sessionId: string, onEvent: (event: SessionStreamEvent) => void): () => void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, size: TerminalSize): Promise<void>;
  /** Ends the session's process; resolves with the ended session. */
  kill(sessionId: string): Promise<SessionInfo>;
  /** The folder the session is in now; where it was last seen once it has ended. */
  cwd(sessionId: string): Promise<string>;
  /** Reveals a folder in the OS file manager (Finder), selected in its parent. Never opens it: a `.app` would launch. */
  revealFolder(path: string): Promise<void>;
  /** Reveals a file in the OS file manager, selected in its folder; never opens it. */
  revealFile(path: string): Promise<void>;
  /** Calls `listener` whenever any session ends. Returns the unsubscribe function. */
  onExited(listener: (event: SessionExitedEvent) => void): () => void;
}

/** The outcome of asking the user for a folder and adding it as a zone. */
export type AddZoneResult =
  | { status: 'added'; zone: Zone }
  | { status: 'cancelled' }
  /** The picked folder can't be a zone (e.g. it is not in a git repo); `message` says why. */
  | { status: 'rejected'; message: string };

/** The outcome of the daemon looking at a folder the user picked. */
export type CheckFolderResult =
  | { status: 'ok'; folder: CheckedFolder }
  | { status: 'rejected'; message: string };

/** The outcome of asking the user for a folder and binding an unbound zone to it. */
export type BindZoneResult =
  | { status: 'bound'; zone: Zone }
  | { status: 'cancelled' }
  /** The zone can't be bound to the picked folder (e.g. it is not in a git repo, or not empty); `message` says why. */
  | { status: 'rejected'; message: string };

/** The outcome of adding a zone for a folder the daemon may refuse. */
export type AddFolderResult =
  | { status: 'added'; zone: Zone }
  /** The folder can't be a zone (e.g. it is no longer in a git repo); `message` says why. */
  | { status: 'rejected'; message: string };

/** The GitHub repos gh can see, or `needsLogin` when gh is not logged in (`refused` says what gh said). */
export type GitHubReposResult = { status: 'ok'; repos: GitHubRepoSource[] } | { status: 'needsLogin'; refused?: string };

/** A zone added, changed or removed, as the daemon announces it. */
export type ZoneChange = ZoneUpdatedEvent | ZoneRemovedEvent;

/** The zone IPC channels between the preload and main. */
export const ZONE_IPC = {
  list: 'zone:list',
  add: 'zone:add',
  addFolder: 'zone:addFolder',
  addUnbound: 'zone:addUnbound',
  clone: 'zone:clone',
  cancelClone: 'zone:cancelClone',
  recentFolders: 'zone:recentFolders',
  githubRepos: 'zone:githubRepos',
  checkFolder: 'zone:checkFolder',
  findCopies: 'zone:findCopies',
  checkoutState: 'zone:checkoutState',
  bind: 'zone:bind',
  update: 'zone:update',
  configure: 'zone:configure',
  setTracker: 'zone:setTracker',
  unbind: 'zone:unbind',
  setDefaultRepo: 'zone:setDefaultRepo',
  roleTemplates: 'zone:roleTemplates',
  setRoleTemplate: 'zone:setRoleTemplate',
  resetRoleTemplate: 'zone:resetRoleTemplate',
  setLook: 'zone:setLook',
  dissolve: 'zone:dissolve',
  restore: 'zone:restore',
  browseFolder: 'zone:browseFolder',
  /** main → renderer: `(ZoneChange)` for every zone change. */
  changed: 'zone:changed',
} as const;

export interface ZonesApi {
  list(): Promise<Zone[]>;
  /**
   * Shows a folder picker ("Browse…") and adds the picked folder as a zone: a repo zone for a git root, a folder zone
   * for a folder inside a repo. Its name defaults to the folder's.
   */
  add(params: NewZoneParams): Promise<AddZoneResult>;
  /** Adds a zone for a folder known already (a recent one, a local clone), with no picker. */
  addFolder(path: string, params: NewZoneParams): Promise<AddFolderResult>;
  /** Adds an unbound zone, with a name and a colour. */
  addUnbound(params: { name: string } & NewZoneParams): Promise<Zone>;
  /**
   * Adds a zone for the GitHub repo `owner/repo`, which the daemon clones; it is bound once the clone finishes. Its
   * tracker is the repo's GitHub Issues unless `params.tracker` names another.
   */
  clone(repo: string, params: NewZoneParams): Promise<Zone>;
  /** Stops a zone's clone: the zone goes, with what was cloned. */
  cancelClone(id: string): Promise<void>;
  /** The folders zones were made for, most recently first. */
  recentFolders(): Promise<RecentFolder[]>;
  /** The GitHub repos gh can see, most recently pushed first, with the local clone of each the daemon knows. */
  githubRepos(): Promise<GitHubReposResult>;
  /**
   * Has the daemon look at a picked folder: in a git repo, and with `repo` (`owner/repo`) set, a copy of that GitHub
   * repo. `rejected` says why not.
   */
  checkFolder(path: string, repo?: string): Promise<CheckFolderResult>;
  /** Has the daemon look one level deep in the usual code folders for copies of GitHub repos; resolves with how many it found. */
  findCopies(): Promise<number>;
  /** The branch the checkout holding `path` is on, its default branch, and whether it has uncommitted changes. Only reads. */
  checkoutState(path: string): Promise<CheckoutState>;
  /** Shows a folder picker and binds the unbound zone to the picked folder, as a repo or as a new project. */
  bind(id: string, as: ZoneBinding): Promise<BindZoneResult>;
  /** Moves and resizes a zone. */
  update(id: string, layout: ZoneLayout): Promise<Zone>;
  /** Changes a zone's settings. */
  configure(id: string, settings: Partial<ZoneSettings>): Promise<Zone>;
  /** Binds the zone to a tracker team, or unbinds it with null. */
  setTracker(id: string, tracker: ZoneTracker | null): Promise<Zone>;
  /** Unbinds the zone back into a group: no repo, tracker or default repo. Its agents keep their own repos. */
  unbind(id: string): Promise<Zone>;
  /** Sets a group's default repo (a repo, or a folder in one), or clears it with null. */
  setDefaultRepo(id: string, path: string | null): Promise<Zone>;
  /** The zone's prompt template for each role. */
  roleTemplates(id: string): Promise<RoleTemplate[]>;
  /** Saves the zone's template for a role. */
  setRoleTemplate(id: string, role: string, body: string): Promise<RoleTemplate>;
  /** Puts the zone's template for a role back to its seed, the repo's worker prompt or the app's own. */
  resetRoleTemplate(id: string, role: string): Promise<RoleTemplate>;
  /** Renames the zone, recolours it (`#rrggbb`) and/or sets its fill opacity (a percent, or null for the theme's own). */
  setLook(id: string, look: { name?: string; color?: string; fillOpacity?: number | null }): Promise<Zone>;
  /**
   * Deletes a zone of any kind in one step: its tiles go loose where they are drawn, then it goes; its items stay, and
   * no session, worktree, branch or repo folder is touched. With `deleteClone`, a managed clone's folder goes too, and
   * `cloneError` says why it could not (the zone is deleted all the same).
   */
  dissolve(id: string, options?: { deleteClone?: boolean }): Promise<{ cloneError: string | null }>;
  /** Makes a deleted zone again, under its own id and with what it had, bound to its repo if it still resolves; undoing a delete does. */
  restore(zone: ZoneSnapshot): Promise<Zone>;
  /** Shows a folder picker ("Browse…") titled `title`, and resolves with the picked folder, or undefined if cancelled. */
  browseFolder(title: string): Promise<string | undefined>;
  /** Calls `listener` whenever a zone is added, changed or removed, by any window or by a clone. Returns the unsubscribe function. */
  onChanged(listener: (change: ZoneChange) => void): () => void;
}

/** A board item changed or was deleted. */
export type ItemChange = ItemUpdatedEvent | ItemRemovedEvent;

/** A change to a connector, as the daemon announces it. */
export type ConnectorChange = ConnectorUpdatedEvent | ConnectorRemovedEvent;

/** The connector IPC channels between the preload and main. */
export const CONNECTOR_IPC = {
  list: 'connector:list',
  create: 'connector:create',
  update: 'connector:update',
  delete: 'connector:delete',
  /** main → renderer: `(ConnectorChange)` for every connector change. */
  changed: 'connector:changed',
} as const;

export interface ConnectorsApi {
  list(): Promise<Connector[]>;
  create(params: CreateConnectorParams): Promise<Connector>;
  /** Changes the look or label of a connector. */
  update(params: UpdateConnectorParams): Promise<Connector>;
  delete(id: string): Promise<void>;
  /**
   * Calls `listener` whenever a connector is created, changed or deleted by any window. One that goes with an object at
   * its end is not announced: drop it when the object goes. Returns the unsubscribe function.
   */
  onChanged(listener: (change: ConnectorChange) => void): () => void;
}

/** A change to a flow edge, a delivery along it included, as the daemon announces it. */
export type FlowEdgeChange = FlowEdgeUpdatedEvent | FlowEdgeRemovedEvent;

/** The flow edge IPC channels between the preload and main. */
export const FLOW_EDGE_IPC = {
  list: 'flow-edge:list',
  create: 'flow-edge:create',
  update: 'flow-edge:update',
  preview: 'flow-edge:preview',
  lastPayload: 'flow-edge:lastPayload',
  commands: 'flow-edge:commands',
  approve: 'flow-edge:approve',
  drop: 'flow-edge:drop',
  settings: 'flow-edge:settings',
  setSettings: 'flow-edge:setSettings',
  send: 'flow-edge:send',
  delete: 'flow-edge:delete',
  /** main → renderer: `(FlowEdgeChange)` for every flow edge change. */
  changed: 'flow-edge:changed',
  /** main → renderer: `(SettingsUpdatedEvent)` whenever a daemon setting changes. */
  settingsChanged: 'flow-edge:settingsChanged',
} as const;

export interface FlowEdgesApi {
  list(): Promise<FlowEdge[]>;
  create(params: CreateFlowEdgeParams): Promise<FlowEdge>;
  /** Changes the edge's rules: its trigger, payload, file and conditions; only those given. */
  update(params: UpdateFlowEdgeParams): Promise<FlowEdge>;
  /** What the edge would carry if its agent handed off now. */
  preview(id: string): Promise<FlowPayloadPreview>;
  /** What the edge last delivered, while the daemon remembers it (not across its restart); null before then. */
  lastPayload(id: string): Promise<FlowDeliveredPayload | null>;
  /** What each of the edge's gates and scripts runs now, and whether you approved it. */
  commands(id: string): Promise<FlowCommandApproval[]>;
  /**
   * Approves what `command` runs, as `commands` showed it (its `fingerprint`), for the sender it was read for (`from`);
   * refused if it has changed since, or the edge's sender has.
   */
  approve(id: string, command: string, fingerprint: string, from: string): Promise<FlowEdge>;
  /** Drops the hand-off the edge holds and the delivery it queued, and their copies. */
  drop(id: string): Promise<FlowEdge>;
  /** The daemon's settings: where held hand-offs are kept, what Needs you lists and when it notifies, and more. */
  settings(): Promise<DaemonSettings>;
  setSettings(settings: Partial<DaemonSettings>): Promise<DaemonSettings>;
  /** Calls `listener` whenever a daemon setting changes, from any window. Returns the unsubscribe function. */
  onSettingsChanged(listener: (change: SettingsUpdatedEvent) => void): () => void;
  /** Delivers the edge's payload now; resolves with the edge and how its delivery went. */
  send(id: string): Promise<FlowEdge>;
  delete(id: string): Promise<void>;
  /**
   * Calls `listener` whenever a flow edge is created, changed or deleted by any window, or delivers. One that goes with
   * an agent at its end is not announced: drop it when the agent goes. Returns the unsubscribe function.
   */
  onChanged(listener: (change: FlowEdgeChange) => void): () => void;
}

/** The review IPC channels between the preload and main. */
export const REVIEW_IPC = {
  list: 'review:list',
  start: 'review:start',
  send: 'review:send',
  dismiss: 'review:dismiss',
  merge: 'review:merge',
  setCap: 'review:set-cap',
  /** main → renderer: `(ReviewUpdatedEvent)` for every review round change. */
  changed: 'review:changed',
} as const;

/** Review rounds: an implementer's reviews by ephemeral reviewer agents, and what to do with their docs. */
export interface ReviewsApi {
  list(): Promise<ReviewRound[]>;
  /** Starts the implementer's next round, spawning its reviewer. */
  start(sessionId: string): Promise<ReviewRound>;
  /** Sends the round's doc to its implementer as its next message; rejects, saying why, when it can't take it now. */
  send(id: string): Promise<ReviewRound>;
  /** Deletes the round's reviewer, keeping its doc. */
  dismiss(id: string): Promise<ReviewRound>;
  /** Squash-merges the implementer's open PR, once the round approves it with no open blocker and its checks pass. */
  merge(id: string): Promise<Agent>;
  setCap(sessionId: string, cap: number): Promise<Agent>;
  /**
   * Calls `listener` whenever a round starts or changes in any window. Rounds that go with their implementer are not
   * announced: drop them when it goes. Returns the unsubscribe function.
   */
  onChanged(listener: (change: ReviewUpdatedEvent) => void): () => void;
}

/** The PR tab's IPC channels between the preload and main. */
export const PULL_REQUEST_IPC = {
  details: 'pull-request:details',
  approve: 'pull-request:approve',
  merge: 'pull-request:merge',
} as const;

/**
 * A pull request as its PR tab shows it, read from GitHub by the daemon with the user's own gh login: no GitHub token
 * reaches the app. Merge and approve only when the user clicks for it, and never on their own.
 */
export interface PullRequestsApi {
  details(ref: PullRequestRef): Promise<PullRequestDetails>;
  /**
   * Approves it as the gh user at `headCommit`, the commit shown, refusing if it has moved on since; answers with it as
   * it is now, or why it couldn't be read again.
   */
  approve(ref: PullRequestRef, headCommit: string): Promise<PullRequestActed>;
  /**
   * Squash-merges it while its head is still `headCommit`, the commit shown; answers as `approve` does. `pastGate` once
   * the user confirmed merging past a gate that hasn't passed on it (`gateBlocked`).
   */
  merge(ref: PullRequestRef, headCommit: string, pastGate: boolean): Promise<PullRequestActed>;
}

/** The merge gate's IPC channels between the preload and main. */
export const GATE_IPC = {
  list: 'gate:list',
  status: 'gate:status',
  run: 'gate:run',
  stop: 'gate:stop',
  log: 'gate:log',
  sendFailure: 'gate:sendFailure',
  merge: 'gate:merge',
  changed: 'gate:changed',
} as const;

/**
 * An agent's merge gate: its zone's gate command run in its worktree, then Merge behind it once the agent has
 * opened a pull request. Each runs only when the user clicks; the app never runs the gate or merges by itself.
 */
export interface GatesApi {
  /** Every agent's latest run. */
  list(): Promise<GateRun[]>;
  /** The agent's latest run, its zone's gate command, the commit its worktree is at and how much is uncommitted. */
  status(sessionId: string): Promise<GateStatus>;
  run(sessionId: string): Promise<GateRun>;
  /** Stops the run and everything it started. */
  stop(sessionId: string): Promise<null>;
  /** A step's log (or, with none, the whole output) from byte `since` on, else its last part. */
  log(sessionId: string, step?: string, since?: number): Promise<GateLog>;
  /** Pastes the failing step's last lines at the agent's prompt, sending nothing; refused while it waits on a permission prompt. */
  sendFailure(sessionId: string, step: string): Promise<null>;
  /**
   * Squash-merges its pull request at `headCommit`, the commit shown, once GitHub (and in a zone with one, the gate)
   * allows, then cleans up as `cleanup` says, keeping a worktree that holds anything that wasn't merged.
   */
  merge(sessionId: string, number: number, headCommit: string, cleanup: GateCleanup): Promise<GateMerged>;
  /** Calls `listener` whenever any agent's run starts, moves on a step or ends. Returns the unsubscribe function. */
  onChanged(listener: (change: GateUpdatedEvent) => void): () => void;
}

/** The IPC channels for agents' questions and plans. */
export const ASK_IPC = {
  answer: 'ask:answer',
  place: 'ask:place',
  plans: 'plan:list',
  decide: 'plan:decide',
  editPlan: 'plan:edit',
  markUnsavedEdit: 'plan:markUnsavedEdit',
  unsavedEdits: 'plan:unsavedEdits',
  unsavedEditsChanged: 'plan:unsavedEditsChanged',
  readDoc: 'doc:read',
  saveDoc: 'doc:save',
  commentDoc: 'doc:comment',
} as const;

/** What the user does with the questions and plans agents wait on. Only their clicks answer them. */
export interface AsksApi {
  /** Answers the agent's question `askId`: an option, their own words, or a skip. */
  answer(sessionId: string, askId: string, answer: AskAnswer): Promise<void>;
  /** Moves the card of the agent's question `askId` on the board to `at`, where it stays until the question goes. */
  place(sessionId: string, askId: string, at: { x: number; y: number }): Promise<void>;
  /** The agent's plans, oldest first, with their bodies. */
  plans(sessionId: string): Promise<Plan[]>;
  /** Decides the agent's plan `planId` while it waits on it. */
  decide(sessionId: string, planId: string, outcome: PlanOutcome, comments: string): Promise<PlanSummary>;
  /** Saves `body` as the user's version of the Markdown plan `planId` the agent waits on: its next version, decided instead. */
  editPlan(sessionId: string, planId: string, body: string): Promise<PlanSummary>;
  /** Says whether this window's Plan tab has a changed, unsaved draft of the agent's plan `planId`, for every window to hold it. */
  markUnsavedEdit(sessionId: string, planId: string, changed: boolean): Promise<void>;
  /** The plans with an unsaved edit in any window, as `planEditKey`s. */
  unsavedEdits(): Promise<string[]>;
  /** Calls `listener` with every plan held whenever that changes. Returns the unsubscribe function. */
  onUnsavedEditsChanged(listener: (keys: string[]) => void): () => void;
  /** A document an agent showed, with its file's text now. */
  readDoc(documentId: string): Promise<DocumentContent>;
  /**
   * Saves the user's `text` over a Markdown document they edited at `baseVersion`: its file is written and its agent
   * told what changed. Refused when the agent wrote it since, unless `force` (keep mine).
   */
  saveDoc(documentId: string, text: string, baseVersion: number, force?: boolean): Promise<DocumentSummary>;
  /** Sends the user's comments on a document to its agent. */
  commentDoc(documentId: string, text: string): Promise<void>;
}

/** The web tab's IPC channels between the preload and main. */
export const WEB_TAB_IPC = {
  open: 'web-tab:open',
  /** An agent's HTML plan, drawn as a web tab's page is, locked down harder. */
  openPlan: 'web-tab:openPlan',
  close: 'web-tab:close',
  forget: 'web-tab:forget',
  handOff: 'web-tab:handOff',
  cancelHandOff: 'web-tab:cancelHandOff',
  /** renderer → main, sent (not invoked) as often as the tab moves: `(tabId, WebTabBounds | null)`. */
  setBounds: 'web-tab:setBounds',
  load: 'web-tab:load',
  back: 'web-tab:back',
  forward: 'web-tab:forward',
  reload: 'web-tab:reload',
  openInBrowser: 'web-tab:openInBrowser',
  openOffered: 'web-tab:openOffered',
  dismissOffered: 'web-tab:dismissOffered',
  /** main → renderer: `(tabId, WebTabState)` as its page loads, moves on or is stopped. */
  changed: 'web-tab:changed',
  /** main → renderer: `(tabId, WebTabKey)`, one of its window's own shortcuts pressed while the page had the keyboard. */
  key: 'web-tab:key',
  focus: 'web-tab:focus',
} as const;

/** Where a web tab's page is drawn in its window, in CSS pixels from the top left of the page. */
export interface WebTabBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a web tab's page is doing, for its address row. */
export interface WebTabState {
  /** The page's URL, or the one it is loading before it first has one. */
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Whether the page has the keyboard: clicked into, so its tab's pane is the window's focused one. */
  focused: boolean;
  /** Why the page isn't showing what was asked: it couldn't load, or it was stopped going somewhere it may not. */
  problem?: string;
  /** The https page the page last asked to open in a new window: never opened but by the user's click (`openOffered`). */
  offered?: string;
}

/** A key pressed in a web tab's page that is its window's to act on, as a `KeyboardEvent` would carry it. */
export type WebTabKey = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/**
 * A web tab's page: a locked-down web view the main process lays over the tab's area of this window. It
 * shows https pages and http ones on this machine only, in a session partition of its own, with no access to the app.
 */
export interface WebTabsApi {
  /**
   * Makes the tab's page, hidden until `setBounds` places it, and loads `url`. `onState` hears how it is doing and `onKey`
   * the window's own shortcuts pressed in it. Returns the function that takes the page away; its partition's data is
   * kept until `forget`.
   */
  open(tabId: string, url: string, listeners: { onState(state: WebTabState): void; onKey(key: WebTabKey): void }): () => void;
  /**
   * Makes a page for an agent's HTML plan, as `open` does for a web page: served from memory, offline, going
   * nowhere and opening nothing (`plan-lockdown.ts`). `forget` lets its page go.
   */
  openPlan(tabId: string, html: string, listeners: { onState(state: WebTabState): void; onKey(key: WebTabKey): void }): () => void;
  /** Draws the page at `bounds`, or hides it with null. */
  setBounds(tabId: string, bounds: WebTabBounds | null): void;
  /** Goes to `url`, if a web tab may show it (`isWebTabUrl`). */
  load(tabId: string, url: string): Promise<void>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  /** Opens the page's URL in the OS browser. */
  openInBrowser(tabId: string): Promise<void>;
  /**
   * Opens the page the page asked to open (`WebTabState.offered`) in the OS browser, as the user clicked for it: only if
   * it is still `shown`, the one the tab showed them.
   */
  openOffered(tabId: string, shown: string): Promise<void>;
  /** Lets the page the page asked to open go unopened. */
  dismissOffered(tabId: string): Promise<void>;
  /** The tab was closed: its page goes, and its partition's cookies, storage and cache with it. */
  forget(tabId: string): Promise<void>;
  /**
   * The tab moves to another window (slice 4), in any window: its page waits, hidden, for the window that
   * opens it next, which takes it as it is, with no reload. One no window takes in a while goes, with its partition's data.
   */
  handOff(tabId: string): Promise<void>;
  /** The move fell through: a page still waiting goes back to the window it left. */
  cancelHandOff(tabId: string): Promise<void>;
  /** Gives the tab's page the keyboard again, as the ⌘K switcher closes over it. */
  focus(tabId: string): Promise<void>;
}

/** The orchestrator IPC channels between the preload and main. */
export const ORCHESTRATOR_IPC = {
  activity: 'orchestrator:activity',
  /** main → renderer: `(OrchestratorActivityEvent)` for every line added to the activity log. */
  logged: 'orchestrator:logged',
} as const;

/** What orchestrators did and tried: the activity log the daemon keeps. */
export interface OrchestratorsApi {
  /** The orchestrator's lines of the activity log, newest first: a page of them, older than the line `before` if given. */
  activity(orchestratorId: string, before?: number): Promise<OrchestratorActivity[]>;
  /** Calls `listener` with each line added to the log. Returns the unsubscribe function. */
  onLogged(listener: (event: OrchestratorActivityEvent) => void): () => void;
}

/** The board item IPC channels between the preload and main. */
export const ITEM_IPC = {
  list: 'item:list',
  create: 'item:create',
  update: 'item:update',
  delete: 'item:delete',
  importImage: 'item:import-image',
  clocks: 'item:clocks',
  addClock: 'item:add-clock',
  /** main → renderer: `(ItemChange)` for every board item change. */
  changed: 'item:changed',
  /** main → renderer: `(ClockUpdatedEvent)` whenever a clock is planned again, fires or a run of it ends. */
  clockChanged: 'item:clock-changed',
} as const;

export interface ItemsApi {
  /** Every board item, lowest first. */
  list(): Promise<BoardItem[]>;
  /** Adds an item on top of the others. */
  create(params: CreateItemParams): Promise<BoardItem>;
  /** Changes the fields of an item that `params` gives. */
  update(params: UpdateItemParams): Promise<BoardItem>;
  delete(id: string): Promise<void>;
  /**
   * Gives the bytes of a PNG, JPEG, GIF or WebP, at most 20 MB, to the daemon's image store, and resolves with the
   * reference for an image item. Rejects for anything else.
   */
  importImage(bytes: ArrayBuffer): Promise<ImageRef>;
  /** Calls `listener` whenever an item changes or is deleted, from any window. Returns the unsubscribe function. */
  onChanged(listener: (change: ItemChange) => void): () => void;
  /** Every clock's next run and latest runs. */
  clocks(): Promise<ClockStatus[]>;
  /** Adds a clock beside an agent's tile (joined to it) or at a place, with `data` over a new clock's. */
  addClock(data: Partial<ClockData>, place: ClockPlace): Promise<BoardItem>;
  /** Calls `listener` with a clock's status whenever it changes. Returns the unsubscribe function. */
  onClockChanged(listener: (event: ClockUpdatedEvent) => void): () => void;
}

/** The outcome of deleting an agent. */
export type DeleteAgentResult =
  | { status: 'deleted' }
  /** Deleting would lose work (`message` says what); ask the user, then delete again with `force`. */
  | { status: 'unsaved'; message: string };

/** The outcome of restarting an ended agent. */
export type RestartAgentResult =
  | { status: 'restarted'; agent: Agent }
  /** The shell its pane dropped into is running something (`message` says so); ask, then restart again with `force`. */
  | { status: 'busy'; message: string };

/** The outcome of starting an agent. */
export type SpawnAgentResult =
  | { status: 'started'; agent: Agent }
  /** The worktree has Codex config of its own (`message` says what that means); ask, then retry with `allowProjectCodexConfig`. */
  | { status: 'confirm'; message: string };

/** An agent changed or was deleted. */
export type AgentChange = AgentUpdatedEvent | AgentRemovedEvent;

/** The app reached the daemon (again): what it knew of agents being started may be out of date, so list them again. */
export interface AgentStartsResetEvent {
  type: 'agent.startsReset';
}

/** An agent's start changed (a step, its name, its failure), or is over; or the starts must be listed again. */
export type AgentStartChange = AgentStartingEvent | AgentStartEndedEvent | AgentStartsResetEvent;

/** The agent IPC channels between the preload and main. */
export const AGENT_IPC = {
  list: 'agent:list',
  spawn: 'agent:spawn',
  start: 'agent:start',
  starts: 'agent:starts',
  retryStart: 'agent:retryStart',
  dismissStart: 'agent:dismissStart',
  updateStart: 'agent:updateStart',
  nextName: 'agent:nextName',
  delete: 'agent:delete',
  answer: 'agent:answer',
  pasteImage: 'agent:pasteImage',
  captureSelection: 'agent:captureSelection',
  askSelection: 'agent:askSelection',
  startMaster: 'agent:startMaster',
  transcript: 'agent:transcript',
  subagentTranscript: 'agent:subagentTranscript',
  interrupt: 'agent:interrupt',
  continueOnCredits: 'agent:continueOnCredits',
  sendUnsent: 'agent:sendUnsent',
  clearUnsent: 'agent:clearUnsent',
  stop: 'agent:stop',
  pause: 'agent:pause',
  resume: 'agent:resume',
  restart: 'agent:restart',
  decidePermission: 'agent:decidePermission',
  link: 'agent:link',
  setSchedule: 'agent:setSchedule',
  markSeen: 'agent:markSeen',
  setMuted: 'agent:setMuted',
  setRecordDeleted: 'agent:setRecordDeleted',
  readDoc: 'agent:readDoc',
  setName: 'agent:setName',
  move: 'agent:move',
  /** Takes the agent the user last asked to open from outside the window (a notification), if any. */
  takeOpenRequest: 'agent:takeOpenRequest',
  /** main → renderer: the user asked to open an agent; take it with `takeOpenRequest`. */
  openRequested: 'agent:openRequested',
  /** main → renderer: `(AgentChange)` for every agent change. */
  changed: 'agent:changed',
  /** main → renderer: `(AgentStartChange)` for every change of an agent's start. */
  startChanged: 'agent:startChanged',
} as const;

export interface AgentsApi {
  /** Every agent, running or ended, with its current state. */
  list(): Promise<Agent[]>;
  /** Starts an agent in the zone, in a new worktree and branch. */
  spawn(params: SpawnAgentParams): Promise<SpawnAgentResult>;
  /**
   * Starts an agent as `spawn` does, resolving with its session id as soon as its tile is on the board (`agent.start`):
   * what fails after that stays on the tile.
   */
  start(params: SpawnAgentParams): Promise<string>;
  /** The agents being started, and the starts that failed. */
  starts(): Promise<AgentStart[]>;
  /** Starts a failed start again; `allowProjectCodexConfig` confirms its warning. */
  retryStart(sessionId: string, allowProjectCodexConfig?: boolean): Promise<void>;
  /** Takes a start off the board, stopping one still going. */
  dismissStart(sessionId: string): Promise<void>;
  /** Renames or moves a start's tile while it starts; once it is an agent, the agent's. */
  updateStart(sessionId: string, change: { name?: string; move?: TileMove }): Promise<void>;
  /** The name an agent started now with no task would get (`new-agent-N`), as the daemon picks it. */
  nextName(): Promise<string>;
  /** Ends the agent and removes its worktree and branch (or keeps them); without `force`, stops short of losing work. */
  delete(sessionId: string, force?: boolean, keepWorktree?: boolean): Promise<DeleteAgentResult>;
  /**
   * Sends `text` to the agent as the user's next message, its line breaks kept; `paste` pastes it even as one line, as
   * a terminal pastes a dropped file's path.
   */
  answer(sessionId: string, text: string, paste?: boolean): Promise<void>;
  /**
   * Keeps a PNG, JPEG, GIF or WebP of at most 20 MB, pasted into the composer, where an agent can read it, and resolves
   * with its path. Rejects for anything else.
   */
  pasteImage(bytes: ArrayBuffer): Promise<string>;
  /**
   * Draws what the window shows in `rect` (CSS px, in the window) as a PNG `width` px wide, for Ask Claude, and leaves
   * it where the daemon takes pictures from; resolves with where.
   */
  captureSelection(rect: { x: number; y: number; width: number; height: number }, width: number): Promise<string>;
  /** Ask Claude about a selection: starts an agent with its picture and diagram (`selection.ask`). */
  askSelection(params: AskSelectionParams): Promise<Agent>;
  /** The Captain: the board's own, or a new one started at board scope (`master.start`, ADR-0019). */
  startMaster(params: StartMasterParams): Promise<Agent>;
  /** Its conversation from its transcript, from entry `since` of `generation` on. */
  transcript(sessionId: string, since: number, generation?: number): Promise<TranscriptChunk>;
  /** A Claude subagent's conversation, started by the agent's call `toolUseId`. */
  subagentTranscript(sessionId: string, toolUseId: string, agentId?: string): Promise<TranscriptChunk>;
  /** Interrupts the agent's turn, as Ctrl-C in its terminal would; resolves with it idle at its prompt. */
  interrupt(sessionId: string): Promise<Agent>;
  /** Resumes the rate-limited agent's turn on usage credits, as its harness offers; resolves with it once its turn starts. */
  continueOnCredits(sessionId: string): Promise<Agent>;
  /**
   * Presses Enter on the message typed at the agent's prompt and never sent (`Agent.unsent`); resolves with the agent
   * once its turn starts or no Enter starts one.
   */
  sendUnsent(sessionId: string): Promise<Agent>;
  /** Clears the message typed at the agent's prompt and never sent (`Agent.unsent`); resolves with the agent. */
  clearUnsent(sessionId: string): Promise<Agent>;
  /** Ends the agent's session, keeping its worktree and branch; resolves with it done. */
  stop(sessionId: string): Promise<Agent>;
  /** Pauses the idle agent (hibernated), ending its session to free what it held; resolves with it paused. */
  pause(sessionId: string): Promise<Agent>;
  /** Starts an agent stopped by restart or paused again, carrying on its conversation; resolves with it live. */
  resume(sessionId: string): Promise<Agent>;
  /**
   * Starts an ended agent again, carrying on its conversation, ending the shell its pane dropped into; without `force`,
   * stops short of ending that shell while it runs something.
   */
  restart(sessionId: string, force?: boolean): Promise<RestartAgentResult>;
  /** Allows or denies the agent's permission prompt `requestId`, while the inbox can still answer it. */
  decidePermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  /** Links the agent to an issue in its repo zone's tracker, or unlinks it with null. */
  link(sessionId: string, issueId: string | null): Promise<Agent>;
  /** Gives the agent a cron schedule, replacing any it had, or takes it away with null. */
  setSchedule(sessionId: string, schedule: ScheduleSpec | null): Promise<Agent>;
  /** Marks the agent's current ask seen, because its session was opened: it stops needing the user until it asks again. */
  markSeen(sessionId: string): Promise<Agent>;
  /** Mutes the agent's OS notifications, or unmutes them. */
  setMuted(sessionId: string, muted: boolean): Promise<Agent>;
  /** Deletes one of the agent's records from its sidebar, or with `deleted` false brings it back. */
  setRecordDeleted(sessionId: string, kind: AgentRecordKind, key: string, deleted: boolean): Promise<Agent>;
  /** Reads one of the agent's hand-off docs, for its Doc tab. */
  readDoc(sessionId: string, path: string): Promise<{ path: string; text: string }>;
  /** Renames the agent's tile. */
  setName(sessionId: string, name: string): Promise<Agent>;
  /** Moves the agent's tile within its zone, into any other, or out onto the board (`zoneId` null). */
  move(sessionId: string, move: TileMove): Promise<Agent>;
  /** Calls `listener` whenever an agent changes or is deleted. Returns the unsubscribe function. */
  onChanged(listener: (change: AgentChange) => void): () => void;
  /** Calls `listener` whenever an agent's start changes or is over. Returns the unsubscribe function. */
  onStartChanged(listener: (change: AgentStartChange) => void): () => void;
  /**
   * Calls `listener` with the agent's session id whenever the user asks to open an agent from outside the window, by
   * clicking its notification: at once for a request made before this window listened. Returns the unsubscribe
   * function.
   */
  onOpenRequested(listener: (sessionId: string) => void): () => void;
}

/** A shell tile changed or was removed. */
export type ShellChange = ShellUpdatedEvent | ShellRemovedEvent;

/** The shell tile IPC channels between the preload and main. */
export const SHELL_IPC = {
  list: 'shell:list',
  create: 'shell:create',
  split: 'shell:split',
  resizeSplit: 'shell:resizeSplit',
  closePane: 'shell:closePane',
  closeOwnPanes: 'shell:closeOwnPanes',
  resumePane: 'shell:resumePane',
  delete: 'shell:delete',
  setName: 'shell:setName',
  setPaneName: 'shell:setPaneName',
  move: 'shell:move',
  createTab: 'shell:createTab',
  ownTab: 'shell:ownTab',
  scripts: 'shell:scripts',
  moveTab: 'shell:moveTab',
  movePane: 'shell:movePane',
  returnPane: 'shell:returnPane',
  windowLayout: 'shell:windowLayout',
  setWindowLayout: 'shell:setWindowLayout',
  unsplitTabs: 'shell:unsplitTabs',
  moveSurface: 'shell:moveSurface',
  forgetWindow: 'shell:forgetWindow',
  tabWindows: 'shell:tabWindows',
  /** main → renderer: `(ShellChange)` for every shell tile change. */
  changed: 'shell:changed',
  /** main → renderer: `(WindowLayoutEvent)` when a window's layout changes other than by the window itself. */
  layoutChanged: 'shell:layoutChanged',
} as const;

export interface ShellsApi {
  /** Every shell tile, and every agent's or shell tile's tab (`owner` set). */
  list(): Promise<Shell[]>;
  /**
   * Opens a shell tab in the owner's session window: in the folder the agent started in or the shell tile's, or `cwd`;
   * or, given `script`, one running that package script there.
   */
  createTab(owner: ShellOwner, options?: { cwd?: string; script?: string }): Promise<Shell>;
  /** The agent's own tab, made the first time it is asked for, so it can be split. */
  ownTab(agentId: string): Promise<Shell>;
  /** The package scripts of the folder the agent started in, or the shell tile's. */
  scripts(owner: ShellOwner): Promise<PackageScripts>;
  /** Starts a shell tile: in a zone, in its folder; or loose on the board at `position`, at home. */
  create(params: CreateShellTileParams): Promise<Shell>;
  /** Moves the shell's tile within its zone, into another, or out onto the board. */
  move(shellId: string, move: TileMove): Promise<Shell>;
  /**
   * Moves a whole shell into an agent's or shell tile's tabs (at `order`, an undo's, if given), or onto the board as a
   * shell tile, its processes untouched; a shell tile takes its tabs with it. Resolves with each shell moved, itself first.
   */
  moveTab(shellId: string, to: ShellPlace, order?: number | null): Promise<Shell[]>;
  /** Moves one pane of a split out into a shell of its own at `to` (with the id `id`, a redo's, if given). */
  movePane(shellId: string, sessionId: string, to: ShellPlace, id?: string): Promise<{ moved: Shell; source: Shell; layoutBefore: PaneLayout }>;
  /** Puts a pane moved out by `movePane` back into the shell, as `layout`, its own shell going. */
  returnPane(shellId: string, sessionId: string, layout: PaneLayout): Promise<Shell>;
  /** How the owner's session window (or a tab window) lays out its tabs in panes; null until it first keeps one. */
  windowLayout(owner: WindowOwner): Promise<WindowLayout | null>;
  /**
   * Keeps how the owner's session window (or a tab window) lays out its tabs in panes: given `base`, the layout it was
   * made from, only if the daemon still has that one. Resolves with the layout kept now.
   */
  setWindowLayout(owner: WindowOwner, layout: WindowLayout, base?: WindowLayout | null): Promise<WindowLayout | null>;
  /**
   * Reads how the owner's session window lays out its tabs, as it opens: tabs split inside themselves before windows
   * had panes are laid out as its panes first, no shell restarting. The layout is null until it first keeps one; the
   * tabs are the owner's as they are now.
   */
  unsplitTabs(owner: WindowOwner): Promise<{ layout: WindowLayout | null; tabs: Shell[] }>;
  /**
   * Moves a pull request, web or session tab out of the window `from` and into `to`'s, at `placement` (slice
   * 4); null for none, either way. Resolves with both layouts and where it was in `from`. Every window hears of both.
   */
  moveSurface(
    surface: Surface,
    from: WindowOwner | null,
    to: { owner: WindowOwner; placement?: Placement } | null,
  ): Promise<{ from: WindowLayout | null; to: WindowLayout | null; was: Placement | null }>;
  /** Forgets a tab window's layout as it closes, if it is still `layout`, the one it last showed; resolves with whether it did. */
  forgetWindow(owner: WindowOwner, layout: WindowLayout): Promise<boolean>;
  /** Every tab window's layout kept: for the board to show again those it has lost track of. */
  tabWindows(): Promise<{ owner: { kind: 'tabs'; id: string }; layout: WindowLayout }[]>;
  /** Calls `listener` when a window's layout changes other than by the window itself: a tab moved in or out. */
  onWindowLayout(listener: (change: WindowLayoutEvent) => void): () => void;
  /** Splits the pane in two, the new pane after it. `horizontal` puts them side by side. */
  split(shellId: string, sessionId: string, direction: SplitDirection, cwd?: string): Promise<Shell>;
  /** Moves a split's divider. */
  resizeSplit(shellId: string, splitId: string, ratio: number): Promise<Shell>;
  /** Closes the pane and ends its session; resolves with null when it was the last one and the tile went too. */
  closePane(shellId: string, sessionId: string): Promise<Shell | null>;
  /** Closes a shell tile's own panes, its next tab becoming its own; resolves with the tile and that tab's id. */
  closeOwnPanes(shellId: string): Promise<{ tile: Shell; promoted: string }>;
  /** Starts a pane stopped by restart again: a new shell in its last folder, under its old output. */
  resumePane(shellId: string, sessionId: string): Promise<Shell>;
  /** Renames the shell's tile. */
  setName(shellId: string, name: string): Promise<Shell>;
  /** Labels a pane, shown in its header in place of the tile's name; null takes the label off. */
  setPaneName(shellId: string, sessionId: string, name: string | null): Promise<Shell>;
  /** Ends every pane and removes the tile. */
  delete(shellId: string): Promise<void>;
  /** Calls `listener` whenever a shell tile changes or is removed. Returns the unsubscribe function. */
  onChanged(listener: (change: ShellChange) => void): () => void;
}

/** An external session changed or was dismissed. */
export type ExternalChange = ExternalUpdatedEvent | ExternalRemovedEvent;

/** How to resume an external session: past the live-elsewhere warning, and where its tile is drawn when the board slotted it. */
export interface ResumeExternalOptions {
  force?: boolean;
  position?: { x: number; y: number };
  cols: number;
  rows: number;
}

/** The outcome of resuming an external session. */
export type ResumeExternalResult =
  | { status: 'resumed'; agent: Agent }
  /** It may still be running in another terminal (`message` says so): ask, then resume again with `force`. */
  | { status: 'live-elsewhere'; message: string };

/** The external session IPC channels between the preload and main. */
export const EXTERNAL_IPC = {
  list: 'external:list',
  dismiss: 'external:dismiss',
  move: 'external:move',
  resumePlan: 'external:resumePlan',
  resume: 'external:resume',
  hooksStatus: 'external:hooksStatus',
  setHooksEnabled: 'external:setHooksEnabled',
  /** main → renderer: `(ExternalChange)` for every external session change. */
  changed: 'external:changed',
} as const;

export interface ExternalApi {
  /** Every external session on the board, live or ended. */
  list(): Promise<ExternalSession[]>;
  /** Takes an external session off the board. */
  dismiss(id: string): Promise<void>;
  /** Moves the session's tile within its zone, into any other, or out onto the board (`zoneId` null). */
  move(id: string, move: TileMove): Promise<ExternalSession>;
  /** What resuming the session in agent-board would mean: where, and whether it may still be running elsewhere. */
  resumePlan(id: string): Promise<ExternalResumePlan>;
  /**
   * Resumes the session in agent-board as an agent, in its tile's place (`position` in its zone for a tile the
   * board slotted). Resolves with the agent, or `live-elsewhere` while it may still run in another terminal, unless `force`.
   */
  resume(id: string, where: ExternalResumeWhere, options: ResumeExternalOptions): Promise<ResumeExternalResult>;
  /** Whether the opt-in global hooks are installed. */
  hooksStatus(): Promise<ExternalHooksStatus>;
  /** Installs the global hooks in `~/.claude` and `~/.codex`, or takes them out. */
  setHooksEnabled(enabled: boolean): Promise<ExternalHooksStatus>;
  /** Calls `listener` whenever an external session changes or is dismissed. Returns the unsubscribe function. */
  onChanged(listener: (change: ExternalChange) => void): () => void;
}

/** The tracker IPC channels between the preload and main. */
export const TRACKER_IPC = {
  status: 'tracker:status',
  connect: 'tracker:connect',
  disconnect: 'tracker:disconnect',
  scopes: 'tracker:scopes',
  projects: 'tracker:projects',
  issues: 'tracker:issues',
  openLink: 'tracker:openLink',
} as const;

/** The teams a tracker's stored credential can see, or why the user must give a credential first. */
export type ScopesResult =
  | { status: 'ok'; scopes: TrackerScope[] }
  /** No credential is stored, or the tracker refused the stored one (`refused` says why): ask for one. */
  | { status: 'needsCredential'; refused?: string };

export interface TrackersApi {
  status(provider: TrackerProvider): Promise<TrackerStatus>;
  /**
   * Checks the API key with the tracker and keeps it in the OS keychain. Resolves with the teams it can see. GitHub
   * has no key: it uses gh's own login.
   */
  connect(provider: TrackerProvider, credential: string): Promise<TrackerScope[]>;
  disconnect(provider: TrackerProvider): Promise<void>;
  /**
   * The teams (or repos) the tracker can see, or `needsCredential` when it has no credential, or it was refused (for
   * GitHub: gh is not logged in). Fails, with the reason, if the tracker can't be asked.
   */
  scopes(provider: TrackerProvider): Promise<ScopesResult>;
  /** The scope's open projects, most recently updated first; Linear only. Fails if the tracker can't be asked. */
  projects(provider: TrackerProvider, scope: string): Promise<TrackerProject[]>;
  /** The zone's open issues (its project's, if it has one), or those matching `query`. */
  issues(zoneId: string, query?: string): Promise<TrackerIssue[]>;
  /** Opens a link from a tracker (an issue, a pull request) in the browser. Only https links. */
  openLink(url: string): Promise<void>;
}

/** How a popped-out session window went away: popped back in to the board, or closed. */
export type PopOutEnd = 'popIn' | 'closed';

/**
 * What a session window shows: one session's terminal, or a shell tile's panes; or, popped out only, a tab window's
 * tabs (slice 4), which are no session's.
 */
export type WindowKind = 'session' | 'shell' | 'tabs';

/** The kind a renderer's query names, if it is one. */
const windowKindFrom = (kind: string | null): WindowKind => (kind === 'shell' || kind === 'tabs' ? kind : 'session');

/** A session window's subject: a session ID or a shell tile ID, as `kind` says, and what its title bar calls it. */
export interface WindowTarget {
  kind: WindowKind;
  id: string;
  title: string;
}

/**
 * The query a renderer window is loaded with: `popOut` (the ID), `kind` and `title` make it one popped-out session
 * window instead of the board; `show`, `kind` and `title` open the board with that window shown.
 */
/** A renderer window's query: what it shows, and the Appearance setting it opens in (`appearance`). */
export const WINDOW_QUERY = { popOut: 'popOut', show: 'show', kind: 'kind', title: 'title', appearance: 'appearance' } as const;

/** The window target a renderer's query names under `idKey`, if any. */
export function windowTargetFrom(query: URLSearchParams, idKey: string): WindowTarget | undefined {
  const id = query.get(idKey);
  if (id === null) return undefined;
  return { kind: windowKindFrom(query.get(WINDOW_QUERY.kind)), id, title: query.get(WINDOW_QUERY.title) ?? '' };
}

/**
 * How a window is framed: `inset` on macOS, with no title bar and the traffic lights over the page, which draws its own
 * drag regions round them; `framed` elsewhere, in the native frame with its window controls.
 */
export type WindowChrome = 'inset' | 'framed';

export function windowChrome(platform: string): WindowChrome {
  return platform === 'darwin' ? 'inset' : 'framed';
}

/** The session window IPC channels between the preload and main. */
export const WINDOW_IPC = {
  popOut: 'window:popOut',
  popIn: 'window:popIn',
  close: 'window:close',
  /** main → renderer: `(WindowTarget, PopOutEnd)` when a popped-out window goes away. */
  returned: 'window:returned',
  isFullScreen: 'window:isFullScreen',
  /** main → renderer: `(boolean)` when the window enters or leaves full screen. */
  fullScreen: 'window:fullScreen',
  /** From a popped-out window: shows another session in it instead (the ⌘K switcher). */
  switchPopOut: 'window:switchPopOut',
  /** main → renderer: `(from: WindowTarget, to: WindowTarget)` when a popped-out window switched sessions. */
  switched: 'window:switched',
  /** From a popped-out window: asks the board's window to do something, bringing it forward (or opening it). */
  boardRequest: 'window:boardRequest',
  /** main → the board: a `BoardRequest` waits; take it with `takeBoardRequest`. */
  boardRequested: 'window:boardRequested',
  takeBoardRequest: 'window:takeBoardRequest',
} as const;

/**
 * What a popped-out window asks the board's window to do, from its ⌘K switcher: bring a zone into view, open New agent
 * with a name, or show a session's window there (from a tab window, which has no session of its own to switch).
 */
export type BoardRequest =
  | { kind: 'zone'; zoneId: string }
  | { kind: 'newAgent'; name: string; zoneId: string | null }
  | { kind: 'open'; target: WindowTarget };

/**
 * What switching a popped-out window did: it shows the session now, the session was out in another OS window already
 * (brought forward instead), or this window is no longer out.
 */
export type PopOutSwitch = 'switched' | 'forward' | 'gone';

/** A point on the screen, in the units of a window's bounds. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * What is dragged out of a session window's strip: a tab (its shell, whole), one pane of a
 * split, or a tab that is only a place in its window (its own session's, a pull request, a web page, another session),
 * by its surface; and the window it is dragged from.
 */
export type TabDrag =
  | { kind: 'tab'; shellId: string; from: ShellOwner }
  | { kind: 'pane'; shellId: string; sessionId: string; from: ShellOwner }
  | { kind: 'surface'; surface: Surface; from: WindowOwner };

/** A move of a shell: whole, or a pane out of its split into a shell of its own. */
export type ShellMove = { kind: 'tab'; shellId: string; to: ShellPlace } | { kind: 'pane'; shellId: string; sessionId: string; to: ShellPlace };

/** A move of a tab that is only a place in a window, out of one window (or none) into another (or none). */
export interface SurfaceMove {
  kind: 'surface';
  surface: Surface;
  from: WindowOwner | null;
  to: { owner: WindowOwner; placement?: Placement } | null;
}

/** A move a drop makes, which the board records for undo. */
export type TabMove = ShellMove | SurfaceMove;

/**
 * The IPC that lets tabs drag between OS windows (slice 4; ADR-0001): every window hears what is dragged,
 * main pops out what was let go outside every window, and the board's window makes every move and keeps their undo.
 */
export const TAB_DRAG_IPC = {
  /** renderer → main: `(TabDrag | null)` as a drag starts in a window, and as it ends or a window takes it. */
  set: 'tabDrag:set',
  /** main → renderer: `(TabDrag | null)`, to every window. */
  changed: 'tabDrag:changed',
  /** renderer → main: `(TabDrag, ScreenPoint?)` when no window took a drag: let go outside them all, the board pops it out there. */
  untaken: 'tabDrag:untaken',
  /** renderer → main: `(TabMove)` from a popped-out window, for the board. */
  move: 'tabDrag:move',
  /** renderer → main: `('undo' | 'redo')` from a popped-out window, for the board's history. */
  history: 'tabDrag:history',
  /** board → main: it hears the moves, pop-outs and undo below from now on; what waited for it comes now. */
  ready: 'tabDrag:ready',
  /** board → main: it made a move, or undid or redid one. */
  settled: 'tabDrag:settled',
  /** main → board: `(TabMove)` to make. */
  makeMove: 'tabDrag:makeMove',
  /** main → board: `(TabDrag, ScreenPoint)` let go outside every window: pop it out there. */
  popOut: 'tabDrag:popOut',
  /** main → board: `('undo' | 'redo')`. */
  replay: 'tabDrag:replay',
  /** main → renderer: the board made a move, or undid or redid one, to every window. */
  settledAll: 'tabDrag:settledAll',
} as const;

export interface TabDragsApi {
  /** Tells every window a tab is dragged in this one (undefined once it ends, or is taken): its data can't be read until it drops. */
  set(drag: TabDrag | undefined): void;
  /** Calls `listener` when a drag starts or ends in any window. Returns the unsubscribe function. */
  onChanged(listener: (drag: TabDrag | undefined) => void): () => void;
  /**
   * A drag no window took has ended, at `at` on the screen if its end said: let go outside every window of the app,
   * the board pops it out there. Refused from a window it wasn't dragged from.
   */
  untaken(drag: TabDrag, at?: ScreenPoint): Promise<void>;
  /**
   * From a popped-out window: has the board make the move and record it for undo, opening the board's window if it is
   * closed. Refused for a move neither into nor (for a tab that is only a place in a window) out of its own window.
   */
  move(move: TabMove): Promise<void>;
  /** From a popped-out window: ⌘Z or ⇧⌘Z, for the board's undo history. Fails while the board's window is closed. */
  history(action: 'undo' | 'redo'): Promise<void>;
  /** From the board: it made a move, or undid or redid one, so every window gives its keyboard back. */
  settled(): void;
  /** Calls `listener` when the board made a move, or undid or redid one. */
  onSettled(listener: () => void): () => void;
  /** From the board, once it is loaded and listening: the moves and pop-outs that waited for it come now. */
  ready(): void;
  /** In the board: the other windows' moves, the drags let go outside every window, and their ⌘Z. Each returns its unsubscribe function. */
  onMakeMove(listener: (move: TabMove) => void): () => void;
  onPopOut(listener: (drag: TabDrag, at: ScreenPoint) => void): () => void;
  onReplay(listener: (action: 'undo' | 'redo') => void): () => void;
}

export interface WindowsApi {
  /**
   * Opens the window in its own OS window, or brings it forward if it is already out. With `reveal: false` (the board
   * taking back the windows it had), one already out is left where it is. Given `at` (where a tab dragged out of a
   * window was let go), it opens, or moves, with its tab strip under that point.
   */
  popOut(target: WindowTarget, options?: { reveal?: boolean; at?: ScreenPoint }): Promise<void>;
  /** From a popped-out window: closes it, and the board shows it again. */
  popIn(id: string): Promise<void>;
  /** Closes the popped-out OS window with this ID, if there is one: e.g. its agent was deleted. */
  close(id: string): Promise<void>;
  /** Calls `listener` when a popped-out window goes away. Returns the unsubscribe function. */
  onReturned(listener: (target: WindowTarget, how: PopOutEnd) => void): () => void;
  /** From a popped-out window: shows `target` in this window instead, unless `target` is out in its own already. */
  switchPopOut(target: WindowTarget): Promise<PopOutSwitch>;
  /** Calls `listener` when a popped-out window switched sessions. Returns the unsubscribe function. */
  onSwitched(listener: (from: WindowTarget, to: WindowTarget) => void): () => void;
  /** From a popped-out window: asks the board's window to do `request`, bringing it forward. */
  requestBoard(request: BoardRequest): Promise<void>;
  /** In the board: calls `listener` with each request a popped-out window made of it. Returns the unsubscribe function. */
  onBoardRequested(listener: (request: BoardRequest) => void): () => void;
  /** How this window is framed. */
  chrome: WindowChrome;
  /** Whether this window is in full screen, where macOS hides its traffic lights. */
  isFullScreen(): Promise<boolean>;
  /** Calls `listener` when this window enters or leaves full screen. Returns the unsubscribe function. */
  onFullScreenChanged(listener: (fullScreen: boolean) => void): () => void;
}

/** The view state IPC channels between the preload and main. */
export const VIEW_IPC = {
  get: 'view:get',
  set: 'view:set',
} as const;

/** How the app left the board (its viewport, its session windows), kept by the daemon so it outlives a restart. */
export interface ViewApi {
  /** The value last saved under `key`, or null. */
  get(key: string): Promise<unknown>;
  /** Saves `value` (JSON, up to 64 KiB) under `key`; null forgets it. */
  set(key: string, value: unknown): Promise<void>;
}

export const APPEARANCE_IPC = {
  get: 'appearance:get',
  set: 'appearance:set',
  /** main → renderer: `(Appearance)` whenever any window picks one. */
  changed: 'appearance:changed',
} as const;

/** The Appearance setting: a mode (Light, Dark or System) and a theme choice. Every window follows it at once. */
export interface AppearanceApi {
  /** The setting as this window opened (`WINDOW_QUERY.appearance`), so its first paint is in the right theme. */
  initial: Appearance;
  get(): Promise<Appearance>;
  set(appearance: Appearance): Promise<void>;
  /** Calls `listener` whenever any window picks one. Returns the unsubscribe function. */
  onChanged(listener: (appearance: Appearance) => void): () => void;
}

export const SETUP_IPC = {
  check: 'setup:check',
  testNotification: 'setup:testNotification',
  /** Main to the board: the app menu's Help › Getting started was picked; take the request with `takeGettingStarted`. */
  gettingStarted: 'setup:gettingStarted',
  takeGettingStarted: 'setup:takeGettingStarted',
  installCli: 'setup:installCli',
} as const;

/** What first-run onboarding checks and sets up. */
export interface SetupApi {
  /** Whether the CLI is installed, its version and whether it is signed in, as the daemon finds it. */
  check(tool: SetupTool): Promise<ToolCheck>;
  /**
   * Raises a test notification: the first one is what makes the OS ask for permission. `shown` is false when this
   * system can't show notifications; Electron can't tell whether the user then allowed them.
   */
  testNotification(): Promise<{ shown: boolean }>;
  /** Calls `listener` when the app menu's Help › Getting started is picked. Returns the function that stops it. */
  onGettingStarted(listener: () => void): () => void;
  /**
   * Links the `agent-board` CLI into `~/.local/bin` (ADR-0010), for terminals outside the app, and resolves with the
   * link's path. Fails when the daemon wrote no CLI, or a file of someone else's is in the way.
   */
  installCli(): Promise<string>;
}

/** What the preload exposes to the renderer as `window.agentBoard`. */
export interface AgentBoardApi {
  daemonHealth(): Promise<DaemonHealth>;
  /** The build this app is. */
  build(): Promise<BuildInfo>;
  /**
   * Stops the daemon and starts this build's. Without `force` it leaves a daemon with live sessions running and says
   * how many there are: ask, then restart again with `force`, which ends them.
   */
  restartDaemon(force: boolean): Promise<RestartDaemonResult>;
  sessions: SessionsApi;
  zones: ZonesApi;
  items: ItemsApi;
  connectors: ConnectorsApi;
  flowEdges: FlowEdgesApi;
  reviews: ReviewsApi;
  pullRequests: PullRequestsApi;
  gates: GatesApi;
  asks: AsksApi;
  webTabs: WebTabsApi;
  orchestrators: OrchestratorsApi;
  agents: AgentsApi;
  shells: ShellsApi;
  external: ExternalApi;
  trackers: TrackersApi;
  windows: WindowsApi;
  tabDrags: TabDragsApi;
  view: ViewApi;
  appearance: AppearanceApi;
  setup: SetupApi;
}
