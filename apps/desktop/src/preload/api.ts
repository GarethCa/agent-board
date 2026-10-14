import type {
  Agent,
  AgentRemovedEvent,
  AgentUpdatedEvent,
  BoardItem,
  BuildInfo,
  Connector,
  ConnectorRemovedEvent,
  ConnectorUpdatedEvent,
  CreateConnectorParams,
  CreateFlowEdgeParams,
  DaemonSettings,
  FlowCommandApproval,
  FlowEdge,
  FlowEdgeRemovedEvent,
  FlowEdgeUpdatedEvent,
  FlowPayloadPreview,
  UpdateFlowEdgeParams,
  ReviewRound,
  ReviewUpdatedEvent,
  CreateItemParams,
  ImageRef,
  CreateShellParams,
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
  Shell,
  TileMove,
  TranscriptChunk,
  ToolCheck,
  ShellRemovedEvent,
  ShellUpdatedEvent,
  SpawnAgentParams,
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
  RecentFolder,
  Zone,
  ZoneBinding,
  ZoneLayout,
  ZoneRemovedEvent,
  ZoneUpdatedEvent,
  ZoneSettings,
  ZoneTracker,
} from '@agent-board/daemon/protocol';
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
  createShell: 'session:createShell',
  list: 'session:list',
  attach: 'session:attach',
  detach: 'session:detach',
  write: 'session:write',
  resize: 'session:resize',
  kill: 'session:kill',
  cwd: 'session:cwd',
  openFolder: 'session:openFolder',
  /** main → renderer: `(attachId, SessionStreamEvent)` for an attachment. */
  event: 'session:event',
  /** main → renderer: `(SessionExitedEvent)` for every session that ends. */
  exited: 'session:exited',
} as const;

export interface SessionsApi {
  createShell(params: CreateShellParams): Promise<SessionInfo>;
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
  /** Opens a folder in the OS file manager (Finder). */
  openFolder(path: string): Promise<void>;
  /** Calls `listener` whenever any session ends. Returns the unsubscribe function. */
  onExited(listener: (event: SessionExitedEvent) => void): () => void;
}

/** The outcome of asking the user for a folder and adding it as a zone. */
export type AddZoneResult =
  | { status: 'added'; zone: Zone }
  | { status: 'cancelled' }
  /** The picked folder can't be a zone (e.g. it is not in a git repo); `message` says why. */
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
  bind: 'zone:bind',
  update: 'zone:update',
  configure: 'zone:configure',
  setTracker: 'zone:setTracker',
  unbind: 'zone:unbind',
  setDefaultRepo: 'zone:setDefaultRepo',
  setLook: 'zone:setLook',
  dissolve: 'zone:dissolve',
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
  /** Shows a folder picker and binds the unbound zone to the picked folder, as a repo or as a new project. */
  bind(id: string, as: ZoneBinding): Promise<BindZoneResult>;
  /** Moves and resizes a zone. */
  update(id: string, layout: ZoneLayout): Promise<Zone>;
  /** Changes a zone's settings. */
  configure(id: string, settings: ZoneSettings): Promise<Zone>;
  /** Binds the zone to a tracker team, or unbinds it with null. */
  setTracker(id: string, tracker: ZoneTracker | null): Promise<Zone>;
  /** Unbinds the zone back into a group: no repo, tracker or default repo. Its agents keep their own repos. */
  unbind(id: string): Promise<Zone>;
  /** Sets a group's default repo (a repo, or a folder in one), or clears it with null. */
  setDefaultRepo(id: string, path: string | null): Promise<Zone>;
  /** Renames the zone and/or recolours it (`#rrggbb`). */
  setLook(id: string, look: { name?: string; color?: string }): Promise<Zone>;
  /** Dissolves a group in one step: its tiles go loose where they are drawn, then it goes; its items stay. */
  dissolve(id: string): Promise<void>;
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
  commands: 'flow-edge:commands',
  approve: 'flow-edge:approve',
  drop: 'flow-edge:drop',
  settings: 'flow-edge:settings',
  setSettings: 'flow-edge:setSettings',
  send: 'flow-edge:send',
  delete: 'flow-edge:delete',
  /** main → renderer: `(FlowEdgeChange)` for every flow edge change. */
  changed: 'flow-edge:changed',
} as const;

export interface FlowEdgesApi {
  list(): Promise<FlowEdge[]>;
  create(params: CreateFlowEdgeParams): Promise<FlowEdge>;
  /** Changes the edge's rules: its trigger, payload, file and conditions; only those given. */
  update(params: UpdateFlowEdgeParams): Promise<FlowEdge>;
  /** What the edge would carry if its agent handed off now. */
  preview(id: string): Promise<FlowPayloadPreview>;
  /** What each of the edge's gates and scripts runs now, and whether you approved it. */
  commands(id: string): Promise<FlowCommandApproval[]>;
  /** Approves what `command` runs, as `commands` showed it (its `fingerprint`); refused if it has changed since. */
  approve(id: string, command: string, fingerprint: string): Promise<FlowEdge>;
  /** Drops the hand-off the edge holds and the delivery it queued, and their copies. */
  drop(id: string): Promise<FlowEdge>;
  /** The daemon's settings: where held hand-offs are kept. */
  settings(): Promise<DaemonSettings>;
  setSettings(settings: Partial<DaemonSettings>): Promise<DaemonSettings>;
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

/** The board item IPC channels between the preload and main. */
export const ITEM_IPC = {
  list: 'item:list',
  create: 'item:create',
  update: 'item:update',
  delete: 'item:delete',
  importImage: 'item:import-image',
  /** main → renderer: `(ItemChange)` for every board item change. */
  changed: 'item:changed',
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

/** The agent IPC channels between the preload and main. */
export const AGENT_IPC = {
  list: 'agent:list',
  spawn: 'agent:spawn',
  nextName: 'agent:nextName',
  delete: 'agent:delete',
  answer: 'agent:answer',
  pasteImage: 'agent:pasteImage',
  transcript: 'agent:transcript',
  subagentTranscript: 'agent:subagentTranscript',
  interrupt: 'agent:interrupt',
  stop: 'agent:stop',
  resume: 'agent:resume',
  restart: 'agent:restart',
  decidePermission: 'agent:decidePermission',
  link: 'agent:link',
  setSchedule: 'agent:setSchedule',
  setMuted: 'agent:setMuted',
  setName: 'agent:setName',
  move: 'agent:move',
  /** Takes the agent the user last asked to open from outside the window (a notification), if any. */
  takeOpenRequest: 'agent:takeOpenRequest',
  /** main → renderer: the user asked to open an agent; take it with `takeOpenRequest`. */
  openRequested: 'agent:openRequested',
  /** main → renderer: `(AgentChange)` for every agent change. */
  changed: 'agent:changed',
} as const;

export interface AgentsApi {
  /** Every agent, running or ended, with its current state. */
  list(): Promise<Agent[]>;
  /** Starts an agent in the zone, in a new worktree and branch. */
  spawn(params: SpawnAgentParams): Promise<SpawnAgentResult>;
  /** The name an agent started now with no task would get (`new-agent-N`), as the daemon picks it. */
  nextName(): Promise<string>;
  /** Ends the agent and removes its worktree and branch; without `force`, stops short of losing work. */
  delete(sessionId: string, force?: boolean): Promise<DeleteAgentResult>;
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
  /** Its conversation from its transcript, from entry `since` of `generation` on. */
  transcript(sessionId: string, since: number, generation?: number): Promise<TranscriptChunk>;
  /** A Claude subagent's conversation, started by the agent's call `toolUseId`. */
  subagentTranscript(sessionId: string, toolUseId: string, agentId?: string): Promise<TranscriptChunk>;
  /** Interrupts the agent's turn, as Ctrl-C in its terminal would; resolves with it idle at its prompt. */
  interrupt(sessionId: string): Promise<Agent>;
  /** Ends the agent's session, keeping its worktree and branch; resolves with it done. */
  stop(sessionId: string): Promise<Agent>;
  /** Starts an agent stopped by restart again, carrying on its conversation; resolves with it live. */
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
  /** Mutes the agent's OS notifications, or unmutes them. */
  setMuted(sessionId: string, muted: boolean): Promise<Agent>;
  /** Renames the agent's tile. */
  setName(sessionId: string, name: string): Promise<Agent>;
  /** Moves the agent's tile within its zone, into any other, or out onto the board (`zoneId` null). */
  move(sessionId: string, move: TileMove): Promise<Agent>;
  /** Calls `listener` whenever an agent changes or is deleted. Returns the unsubscribe function. */
  onChanged(listener: (change: AgentChange) => void): () => void;
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
  resumePane: 'shell:resumePane',
  delete: 'shell:delete',
  setName: 'shell:setName',
  setPaneName: 'shell:setPaneName',
  move: 'shell:move',
  /** main → renderer: `(ShellChange)` for every shell tile change. */
  changed: 'shell:changed',
} as const;

export interface ShellsApi {
  /** Every shell tile. */
  list(): Promise<Shell[]>;
  /** Starts a shell tile: in a zone, in its folder; or loose on the board at `position`, at home. */
  create(params: CreateShellTileParams): Promise<Shell>;
  /** Moves the shell's tile within its zone, into another, or out onto the board. */
  move(shellId: string, move: TileMove): Promise<Shell>;
  /** Splits the pane in two, the new pane after it. `horizontal` puts them side by side. */
  split(shellId: string, sessionId: string, direction: SplitDirection, cwd?: string): Promise<Shell>;
  /** Moves a split's divider. */
  resizeSplit(shellId: string, splitId: string, ratio: number): Promise<Shell>;
  /** Closes the pane and ends its session; resolves with null when it was the last one and the tile went too. */
  closePane(shellId: string, sessionId: string): Promise<Shell | null>;
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

/** What a session window shows: one session's terminal, or a shell tile's panes. */
export type WindowKind = 'session' | 'shell';

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
  return { kind: query.get(WINDOW_QUERY.kind) === 'shell' ? 'shell' : 'session', id, title: query.get(WINDOW_QUERY.title) ?? '' };
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
} as const;

export interface WindowsApi {
  /**
   * Opens the window in its own OS window, or brings it forward if it is already out. With `reveal: false` (the board
   * taking back the windows it had), one already out is left where it is.
   */
  popOut(target: WindowTarget, options?: { reveal?: boolean }): Promise<void>;
  /** From a popped-out window: closes it, and the board shows it again. */
  popIn(id: string): Promise<void>;
  /** Closes the popped-out OS window with this ID, if there is one: e.g. its agent was deleted. */
  close(id: string): Promise<void>;
  /** Calls `listener` when a popped-out window goes away. Returns the unsubscribe function. */
  onReturned(listener: (target: WindowTarget, how: PopOutEnd) => void): () => void;
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

/** The Appearance setting: System or a theme. Every window follows it at once. */
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
  agents: AgentsApi;
  shells: ShellsApi;
  external: ExternalApi;
  trackers: TrackersApi;
  windows: WindowsApi;
  view: ViewApi;
  appearance: AppearanceApi;
  setup: SetupApi;
}
