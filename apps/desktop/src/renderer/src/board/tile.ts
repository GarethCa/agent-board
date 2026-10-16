import { createContext } from 'react';
import type { Node } from '@xyflow/react';
import type { Agent, ExternalSession, Harness, PullRequest, RecentFolder, Shell } from '@agent-board/daemon/protocol';
import type { ClickOpens } from './click-opens';
import { renameDirect, type RenameTarget } from './rename';

/** What a tile shows, whatever representation draws it. */
export type TileData = {
  label: string;
  /** The harness the session runs, or null for a shell session. */
  harness: Harness | null;
  /** This tile's representation, overriding the board-wide one. */
  style?: string;
  /** The agent the tile stands for; unset for placeholder tiles. */
  agent?: Agent;
  /** The name of the agent's repo, when its tile sits outside every zone of that repo. */
  repo?: string;
  /** The external session the tile stands for, instead of an agent. */
  external?: ExternalSession;
  /** The shell tile the tile stands for, instead of an agent. */
  shell?: Shell;
  /** Expanded in place: drawn by `ExpandedTile` rather than the representation. */
  expanded?: true;
  /** A closed agent shrunk to a chip: drawn by `FoldedChip`, at `CHIP_SIZE`. */
  folded?: true;
  /** How far a folded chip is drawn below its tile's saved top, px, to sit centred in the tile's place: drawn only, never saved. */
  lift?: number;
  /** The orchestrator that started the agent, while it is on the board. */
  from?: { sessionId: string; name: string };
  /** How many agents on the board the agent started, as an orchestrator. */
  crew?: number;
  /** The tabs of the agent's session window, when it has any: its shells chip lists their shells. */
  tabs?: Shell[];
};

export type TileNodeType = Node<TileData, 'tile'>;

/** The props every representation's tile component takes. */
export interface TileProps {
  id: string;
  tile: TileData;
}

/** What a tile can ask the board to do with its agent. */
export interface TileActions {
  /**
   * Expands the tile (by node id) in place, or brings it to the front if it is expanded. A session already in its own
   * OS window has that window brought forward instead.
   */
  expand(nodeId: string): void;
  /** Unfolds a closed agent's chip to its full tile (`open`), or folds the tile back to its chip. */
  setFolded(nodeId: string, folded: boolean): void;
  /** Returns the expanded tile to compact; its session keeps running. */
  collapse(nodeId: string): void;
  /**
   * Saves the size the user let a compact tile go at, and its `place` if resizing from the left or top moved
   * it; both are one undo step. No size puts it back to the default.
   */
  resizeTile(nodeId: string, size: { width: number; height: number } | undefined, place?: { x: number; y: number }): void;
  /**
   * Keeps the size an expanded tile was let go at, for it to open at again, and saves its `place` as let go (its
   * top-left, relative to its parent) if that isn't where its place is saved.
   */
  resizeExpanded(nodeId: string, size: { width: number; height: number }, place: { x: number; y: number }): void;
  /** Opens the tile's session window, maximised (an agent's or a shell tile's; an external session has none). */
  maximise(tile: TileData): void;
  /** Opens the agent's session window (maximised), collapsing it if expanded. */
  openAgent(agent: Agent): void;
  /** Opens the shell tile's session window, with its panes, collapsing it if expanded. */
  openShell(shell: Shell): void;
  /** Opens the agent's session window in its own OS window, collapsing it if expanded. */
  popOutAgent(agent: Agent): void;
  /** Opens the shell tile's session window in its own OS window, collapsing it if expanded. */
  popOutShell(shell: Shell): void;
  /** Asks to delete the shell tile, confirming first if it has live panes. */
  deleteShell(shellId: string): void;
  /** Asks to delete the agent, confirming first if that would lose work. */
  deleteAgent(sessionId: string): void;
  /** Asks which issue to link the agent to. */
  linkIssue(agent: Agent): void;
  /** Opens the agent's schedule editor. */
  scheduleAgent(agent: Agent): void;
  /** Mutes the agent's OS notifications, or unmutes them. */
  setMuted(sessionId: string, muted: boolean): void;
  /**
   * Renames an agent's or shell's tile, or labels a shell's pane (a blank name takes a pane's label off). Rejects if
   * it could not (after saying why), so the field can stay as it was. Undoable on the board.
   */
  rename(target: RenameTarget, name: string): Promise<void>;
  /** Opens a link from a tracker in the browser: the agent's linked issue, or one of its pull requests. */
  openLink(url: string): void;
  /** Takes an external session's tile off the board. */
  dismissExternal(id: string): void;
  /** Asks to resume an external session in agent-board as an agent, in its tile's place. */
  resumeExternal(session: ExternalSession): void;
  /** Starts an agent stopped by a restart again; settles once it has (or failing that, said why). */
  resumeAgent(sessionId: string): Promise<void>;
  /** Restarts an ended agent, asking first if the shell its pane dropped into is running something. */
  restartAgent(sessionId: string): void;
  /** Starts a shell tile's panes stopped by a restart again; settles once it has (or failing that, said why). */
  resumeShell(shell: Shell): Promise<void>;
  /** Starts the agent's next review round, spawning its reviewer. */
  startReview(agent: Agent): void;
  /** Opens the implementer's session window on its Review tab. */
  openReview(implementer: string): void;
  /**
   * Opens the agent's session window on one of its terminal tabs, by id, or on a new shell tab where it
   * started when `tab` is undefined.
   */
  openTab(agent: Agent, tab: string | undefined): void;
  /**
   * Opens one of the agent's pull requests in a PR tab (BI1): in its expanded tile, if it is expanded, else in
   * its session window; in the focused pane, or where its tab already is.
   */
  openPullRequest(agent: Agent, pr: PullRequest): void;
  /**
   * Opens the agent's Gate tab (BL1) where a PR tab would open, and with `run`, runs its gate first (only ever
   * on the user's click), saying why when it can't.
   */
  openGate(agent: Agent, run: boolean): void;
  /** Opens the agent's Plan tab (BO2) where a PR tab would open. */
  openPlan(agent: Agent): void;
}

/** What a double-click on an agent's or shell tile opens: its tiles' tooltips and ⋯ menus say so. */
export const ClickOpensContext = createContext<ClickOpens>('window');

export const TileActionsContext = createContext<TileActions>({
  expand: () => {},
  collapse: () => {},
  setFolded: () => {},
  resizeTile: () => {},
  resizeExpanded: () => {},
  maximise: () => {},
  openAgent: () => {},
  openShell: () => {},
  popOutAgent: () => {},
  popOutShell: () => {},
  deleteShell: () => {},
  deleteAgent: () => {},
  linkIssue: () => {},
  scheduleAgent: () => {},
  setMuted: () => {},
  // Outside the board (a popped-out window) there is no history to record in.
  rename: async (target, name) => void (await renameDirect(target, name)),
  openLink: () => {},
  dismissExternal: () => {},
  resumeExternal: () => {},
  resumeAgent: async () => {},
  restartAgent: () => {},
  resumeShell: async () => {},
  startReview: () => {},
  openReview: () => {},
  openTab: () => {},
  openGate: () => {},
  openPlan: () => {},
  openPullRequest: () => {},
});

/** What a shell tile's folder chip needs (AK1): home, to show it as `~`, and where to open a new pane. */
export interface ShellFolders {
  /** The home directory loose shells start in; undefined until the daemon says. */
  home: string | undefined;
  /** The folders to offer: recent repos and folders. */
  recent(): Promise<RecentFolder[]>;
  /** Opens a new pane of the shell in `cwd`, or in a folder the user browses for without one. */
  newPaneIn(shell: Shell, cwd?: string): void;
}

export const ShellFoldersContext = createContext<ShellFolders>({ home: undefined, recent: async () => [], newPaneIn: () => {} });
