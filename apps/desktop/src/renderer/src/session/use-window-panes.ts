import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useToast } from '../ui';
import { paneIds, setSplitRatio, type SplitDirection } from '@agent-board/daemon/pane-layout';
import { isOwnedBy, type PackageScripts, type Shell } from '@agent-board/daemon/protocol';
import {
  OWN_SURFACE,
  paneOfSurface,
  placeSurface,
  reconcileWindow,
  removeSurface,
  selectSurface,
  singlePane,
  surfaceKey,
  updateSurface,
  windowPanes,
  type Placement,
  type Surface,
  type WebSurface,
  type WindowLayout,
} from '@agent-board/daemon/window-layout';
import { errorMessage } from '../../../shared/errors';
import { bySession, nearestInDirection, paneGeometry, type Direction, type Rect } from './pane-geometry';
import { arrivalPlacement, expectArrival, noteDepartures, settleArrival } from './placements';
import { dropKey, dropMove, type TabDrag, type TabMove } from './shell-moves';
import { noRoomToSplit } from './split-room';
import { chosenFontSize } from './terminal-size';
import { useTabRequest } from './tab-request';
import {
  OWN_TAB,
  localServersOf,
  newWebTabs,
  pullRequestChoices,
  sessionChoices,
  shellOwner,
  windowOwner,
  tabAtDigit,
  tabKey,
  tabLiveShells,
  windowShells,
  windowSurfaces,
  windowTabs,
  worstState,
  type LocalServer,
  type ShellState,
  type TabOwner,
  type WindowSurface,
} from './tabs';
import { useLiveAgents, useLiveShells } from './use-live-board';
import { draggedWithin, givesUp, surfaceDrag, surfaceMoveInto } from './window-drags';
import { ownTabNotice, windowPaneKey, type WindowPaneKey } from './window-keys';

/** One pane of the window as it is drawn: where it is, and its strip's surfaces, the one it shows among them. */
export interface PaneView {
  id: string;
  /** Where it is in the window, as fractions of it. */
  rect: Rect;
  surfaces: WindowSurface[];
  active: WindowSurface;
}

export interface WindowPanesControl {
  layout: WindowLayout;
  /** Whether the window has shells of its own to open: not a tab window (slice 4), which holds no shell. */
  holdsShells: boolean;
  panes: PaneView[];
  /** Every surface of the window, each in one pane. */
  surfaces: WindowSurface[];
  /** The pane with the keyboard. */
  focusedPane: PaneView;
  /** The session with the keyboard: in the surface the focused pane shows, its focused pane if it is split. */
  focusedSession: string | undefined;
  /** The session with the keyboard in the surface, kept while it isn't showing: the one last clicked, else its first. */
  focusIn(surface: WindowSurface): string | undefined;
  /** Whether the surface is the one its pane shows. */
  showing(key: string): boolean;
  /** Gives the session the keyboard, in whichever surface it is, and that surface's pane. */
  focus(sessionId: string): void;
  focusPane(paneId: string): void;
  /** Shows the surface in its pane, and gives that pane the keyboard. */
  select(key: string): void;
  /** Whether the surface's tab has a ×: every one but an agent's own, and a shell tile's own while it is its only tab. */
  closable(surface: WindowSurface): boolean;
  /**
   * Closes a tab: a shell tab's shells end (once `confirmClose` says so, while one runs); another session's just leaves;
   * a web tab's page goes, and its partition's data with it.
   */
  close(key: string): void;
  /** The tab waiting to be closed until the user says so, as its shells still run. */
  closing: WindowSurface | undefined;
  confirmClose(confirmed: boolean): void;
  /** Opens a shell tab in the pane (else the focused one), where the window's shells start, in `cwd`, or running a script. */
  newTab(paneId?: string, options?: { cwd?: string; script?: string }): void;
  /** Opens a shell tab in the pane, in a folder the user browses for. */
  newTabAt(paneId?: string): void;
  scripts(): Promise<PackageScripts>;
  /** The other agents and shell tiles the + menu offers to show here as a tab. */
  sessionChoices: WindowSurface[];
  /** Shows another session as a tab of the pane. */
  showSession(paneId: string, surface: Surface): void;
  /**
   * Shows the surface, with the keyboard: where its tab is, or, for anything but its own session or a shell tab of its
   * own not open here (a pull request, a web page, another session, a doc…), in a new tab of the pane (else the focused one).
   */
  open(surface: Surface, paneId?: string): void;
  /** Shows `url` in a web tab: one of the window's already at it, else a new one in the pane (else the focused one). */
  openWeb(url: string, paneId?: string): void;
  /** Keeps where a web tab's page went, to reload it there at the next start. */
  navigated(web: WebSurface): void;
  /**
   * Opens a new web tab with no page in the pane (else the focused one): its address bar is for typing in, over the
   * `localServers` it offers. A `private` one keeps no login past itself.
   */
  openBlankWeb(paneId?: string, options?: { private?: boolean }): void;
  /** The local dev servers the window's running shells listen on, each with the shell that runs it, for a blank web tab to offer. */
  localServers: LocalServer[];
  /** The agent's pull requests the + menu offers to open as a tab. */
  pullRequestChoices: { label: string; surface: Surface }[];
  /** Splits the pane (else the focused one), a new shell tab in the new pane, beside it or below it, with the keyboard. */
  split(direction: SplitDirection, paneId?: string): void;
  /**
   * The details' Split: a shell tile's own panes split inside its tab, tmux-style, as they always have;
   * anything else splits the window, as ⌘D does. Undefined while the focused pane shows another session.
   */
  splitFromDetails: ((direction: SplitDirection) => void) | undefined;
  /** Saves where a divider between panes was left. */
  resize(splitId: string, ratio: number): Promise<void>;
  /** Whether a tab or pane dragged would land in this window, dropped at a pane's strip or body. */
  accepts(drag: TabDrag): boolean;
  /** Lands a dragged tab or pane at `placement`: moved within the window, or into it from another, in any OS window. */
  drop(drag: TabDrag, placement: Placement): void;
  /** What one of the window's tabs drags as. */
  dragOf(surface: WindowSurface): TabDrag;
  /** Takes in a tab as a call returned it. */
  apply(shell: Shell): void;
  /** How each shell tab's shells are doing, by surface key: the worst of them. */
  dots: ReadonlyMap<string, ShellState>;
  /** The window's pane keys (`windowPaneKey`), before the terminal or the board sees them. A held key acts once. */
  onKeyDown(event: KeyboardEvent): void;
  /**
   * One of the window's pane keys pressed where the window's page can't hear it, in a web tab's page: it acts on that
   * tab's pane, which takes the keyboard. Returns whether it was one.
   */
  paneKey(paneId: string, key: Parameters<typeof windowPaneKey>[0]): boolean;
}

const newId = () => crypto.randomUUID();

/** Each window's layout as this page last kept it or heard of it from the daemon, by its owner's drop key. */
const kept = new Map<string, WindowLayout | null>();

/** The owner's window layout as this page last kept it, or heard of it: what a tab window forgets as it closes. */
export const keptLayout = (owner: { kind: string; id: string }): WindowLayout | null | undefined => kept.get(dropKey(owner));

/** How long a window waits to read its layout again after reading it failed. */
const REREAD_MS = 3000;

/** The sessions a surface shows: its panes, or the agent's session. */
function sessionsOf(surface: WindowSurface): string[] {
  switch (surface.kind) {
    case 'tab':
      return paneIds(surface.tab.layout);
    case 'agent':
      return [surface.agent.sessionId];
    case 'tile':
      return paneIds(surface.shell.layout);
    case 'pr':
    case 'web':
    case 'gate':
    case 'plan':
    case 'doc':
    case 'document':
      return [];
    default: {
      const unknown: never = surface;
      throw new Error(`a surface of no known kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * The layout the daemon keeps for the window `key` names: `layout` (null for none kept yet) once read, or, while it
 * can't be read, `unread` with why. A window laid out while its layout is unread keeps nothing.
 */
type Stored = { key: string; layout: WindowLayout | null; unread?: string };

/** The terminal's font size when none is chosen: the body size the terminals take from the theme. */
const DEFAULT_FONT_SIZE = 13;

/**
 * The panes of an agent's or a shell tile's session window, or a tab window's (slice 4):
 * each pane has its own strip of tabs, and the window keeps how they are laid out with the daemon, so it outlives a
 * restart; a tab moved in or out of it from another window is laid out by the daemon, which the window hears of. A window with no layout
 * kept yet shows one pane holding its tabs, as before panes; a tab split inside itself before panes has its split laid
 * out as panes by the daemon as the window reads its layout (`shell.unsplitTabs`). Tabs gone elsewhere leave their
 * pane (which closes when empty), and tabs arriving go where they were dropped, else where they last were here, else
 * the focused pane. Nothing is kept until the layout and every tab and session it might hold have been read.
 * Undefined for a window with no owner, or a shell tile not listed yet.
 */
export function useWindowPanes(
  owner: TabOwner | undefined,
  options: { onProblem(problem: string | undefined): void; moves: ((move: TabMove) => void) | undefined },
): WindowPanesControl | undefined {
  const { onProblem, moves } = options;
  const named = owner === undefined ? undefined : windowOwner(owner);
  /** Whose shells the window's are: none in a tab window. */
  const shellsOf = owner === undefined ? undefined : shellOwner(owner);
  const key = named === undefined ? undefined : dropKey(named);
  const { shells, problem: shellsProblem, apply } = useLiveShells();
  const { agents, problem: agentsProblem } = useLiveAgents();
  const [stored, setStored] = useState<Stored>();
  const [focusedPaneId, setFocusedPaneId] = useState<string>();
  const [focused, setFocused] = useState<Record<string, string>>({});
  const [closingKey, setClosingKey] = useState<string>();
  /** A tab asked for (a row of the tile's shells chip) before the layout it is in was read. */
  const [requested, setRequested] = useState<Surface>();
  /** The layout last taken, for the window `key` names. */
  const committed = useRef<{ key: string; layout: WindowLayout | null }>(undefined);
  /** The layout as drawn, or as changed since: what a change, even one made as a call answers later, starts from. */
  const working = useRef<WindowLayout>(undefined);
  const openRef = useRef<(surface: Surface) => void>(undefined);
  /** Changes asked for before the layout was read (⌘D as the window opens), made once it is. */
  const early = useRef<((current: WindowLayout) => WindowLayout | null)[]>([]);

  useEffect(() => {
    if (named === undefined || key === undefined) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      window.agentBoard.shells.unsplitTabs(named).then(
        ({ layout, tabs }) => {
          if (!alive) return;
          // Tabs the daemon just made are taken in first: a layout settled without them would lose them.
          for (const tab of tabs) apply(tab);
          committed.current = { key, layout };
          kept.set(key, layout);
          setStored({ key, layout });
        },
        // Laid out from its tabs meanwhile, keeping nothing: what the daemon has is kept until it can be read.
        (error: unknown) => {
          if (!alive) return;
          setStored((current) => (current?.key === key && current.unread === undefined ? current : { key, layout: null, unread: errorMessage(error) }));
          retry = setTimeout(read, REREAD_MS);
        },
      );
    void read();
    // A tab moved in or out from another window: the daemon laid it out, and this window takes that as it is.
    const unsubscribe = window.agentBoard.shells.onWindowLayout((change) => {
      if (!alive || dropKey(change.owner) !== key) return;
      clearTimeout(retry);
      committed.current = { key, layout: change.layout };
      kept.set(key, change.layout);
      // What a change made before the next render starts from: never the layout the move outdated.
      if (change.layout !== null) working.current = change.layout;
      setStored({ key, layout: change.layout });
    });
    return () => {
      alive = false;
      clearTimeout(retry);
      unsubscribe();
    };
    // `named` is a new object each render; its key names it.
  }, [key]);

  // Why the window can't be laid out as kept, if it can't: what it shows meanwhile is kept nowhere.
  const unreadable =
    stored !== undefined && stored.key === key && stored.unread !== undefined
      ? `could not read how the window was laid out (${stored.unread}): its saved layout is kept, and nothing here is saved until it can be read`
      : shellsProblem !== undefined
        ? `could not list the shells (${shellsProblem}): trying again`
        : agentsProblem !== undefined
          ? `could not list the agents (${agentsProblem}): trying again`
          : undefined;
  useEffect(() => {
    if (unreadable === undefined) return;
    onProblem(unreadable);
    return () => onProblem(undefined);
  }, [unreadable, onProblem]);

  const owned = shells?.filter((shell) => shellsOf !== undefined && isOwnedBy(shell, shellsOf)) ?? [];
  const read = named !== undefined && stored !== undefined && stored.key === key && shells !== undefined && agents !== undefined;
  const shownBefore = read && stored.layout !== null ? windowPanes(stored.layout).flatMap((pane) => pane.tabs) : [];
  /** A tab window with no tab left to show: it goes, and nothing of it is laid out or kept. */
  const empty = owner?.kind === 'tabs' && (!read || windowSurfaces(owner, [], shownBefore, { agents: agents ?? [], tiles: shells ?? [] }).length === 0);
  // Laid out from the lists only once they are all read: a layout settled against half a list would lose what it holds.
  const loaded = read && !empty;
  /** Whether what the window lays out may be kept: not while the layout the daemon has couldn't be read. */
  const keeps = loaded && stored.unread === undefined;
  const saved = loaded ? stored.layout : null;
  const shown = saved === null ? [] : windowPanes(saved).flatMap((pane) => pane.tabs);
  const surfaces = owner === undefined ? [] : windowSurfaces(owner, owned, shown, { agents: agents ?? [], tiles: shells ?? [] });
  const shellsById = new Map(owned.map((shell) => [shell.id, shell]));
  const layout = loaded
    ? reconcileWindow(
        saved,
        surfaces.map((surface) => surface.surface),
        {
          newId,
          into: focusedPaneId,
          placement: (surface) => {
            const shell = surface.kind === 'shell' ? shellsById.get(surface.shellId) : undefined;
            return shell === undefined || shellsOf === undefined ? undefined : arrivalPlacement(shellsOf, shell);
          },
        },
      )
    : singlePane(surfaces.length === 0 ? [{ kind: 'own' }] : surfaces.map((surface) => surface.surface));

  /** Takes `next` as the window's layout, noting which tabs left it and which arrived, and keeps it if it may. */
  const commit = (next: WindowLayout) => {
    if (!loaded || named === undefined || key === undefined) return;
    const before = committed.current?.key === key ? committed.current.layout : null;
    if (next === before) return;
    committed.current = { key, layout: next };
    working.current = next;
    if (shellsOf !== undefined) {
      if (before !== null) noteDepartures(shellsOf, before, next);
      for (const pane of windowPanes(next)) {
        for (const tab of pane.tabs) {
          const shell = tab.kind === 'shell' ? shellsById.get(tab.shellId) : undefined;
          if (shell !== undefined && (before === null || paneOfSurface(before, surfaceKey(tab)) === undefined)) settleArrival(shellsOf, shell);
        }
      }
    }
    setStored((current) => ({ key, layout: next, ...(current?.unread === undefined ? {} : { unread: current.unread }) }));
    if (!keeps) return;
    // Kept only over the layout it was made from: one made before a tab moved in or out, the daemon drops, and this
    // window hears of the move. Dropped otherwise, what the daemon has is what the next change starts from.
    const base = kept.get(key);
    kept.set(key, next);
    window.agentBoard.shells.setWindowLayout(named, next, base).then(
      (stored) => {
        if (stored !== next && kept.get(key) === next && JSON.stringify(stored) !== JSON.stringify(next)) kept.set(key, stored);
      },
      (error: unknown) => onProblem(`could not keep the window's layout: ${errorMessage(error)}`),
    );
  };
  working.current = layout;
  // A layout settled afresh (a tab arrived or went) is taken as it is drawn, with any change asked for before it was read.
  useEffect(() => {
    if (!loaded) return;
    // Drawn from a layout this window has moved on from since (a tab moved in or out, heard of after this render): the
    // next render settles the one it took; this one, kept, would put back what moved.
    if (committed.current?.key === key && committed.current.layout !== saved) return;
    const asked = early.current.splice(0);
    const next = asked.reduce<WindowLayout>((current, edit) => edit(current) ?? current, layout);
    if (next !== committed.current?.layout) commit(next);
  });

  // A row of the tile's shells chip asks for its tab, shown once the layout it is in is read.
  useTabRequest(named?.id, setRequested);
  useEffect(() => {
    if (!loaded || requested === undefined) return;
    setRequested(undefined);
    openRef.current?.(requested);
  }, [loaded, requested]);

  if (owner === undefined || named === undefined || empty) return undefined;

  /** Changes the layout as it is now, which an answer arriving later may find moved on, and gives the result. */
  const change = (edit: (current: WindowLayout) => WindowLayout | null): WindowLayout => {
    if (!loaded) {
      early.current.push(edit);
      return working.current!;
    }
    const next = edit(working.current!);
    if (next === null) return working.current!;
    commit(next);
    return next;
  };
  /** Puts the surface at `placement`, showing it, and gives its pane the keyboard. */
  const placeAndShow = (surface: Surface, placement: Placement) => {
    const next = change((current) => selectSurface(placeSurface(current, surface, placement, newId), surfaceKey(surface)));
    setFocusedPaneId(paneOfSurface(next, surfaceKey(surface))?.id ?? placement.pane);
  };
  const run = (what: string, action: () => Promise<void>) => {
    onProblem(undefined);
    action().catch((error: unknown) => onProblem(`could not ${what}: ${errorMessage(error)}`));
  };

  const geometry = paneGeometry(layout, (pane) => pane.id);
  const byKey = new Map(surfaces.map((surface) => [surface.key, surface]));
  const panes: PaneView[] = windowPanes(layout).map((pane) => {
    const strip = pane.tabs.flatMap((tab) => byKey.get(surfaceKey(tab)) ?? []);
    return { id: pane.id, rect: geometry.panes.find((each) => each.id === pane.id)!.rect, surfaces: strip, active: byKey.get(pane.active) ?? strip[0]! };
  });
  const focusedPane = panes.find((pane) => pane.id === focusedPaneId) ?? panes.find((pane) => pane.surfaces.some((surface) => surface.key === OWN_SURFACE)) ?? panes[0]!;
  const focusIn = (surface: WindowSurface) => {
    const sessions = sessionsOf(surface);
    const last = focused[surface.key];
    return last !== undefined && sessions.includes(last) ? last : sessions[0];
  };
  const paneOf = (surfaceKeyOf: string) => panes.find((pane) => pane.surfaces.some((surface) => surface.key === surfaceKeyOf));
  const select = (show: string) => {
    const pane = paneOf(show);
    if (pane === undefined) return;
    setFocusedPaneId(pane.id);
    change((current) => selectSurface(current, show));
  };
  /** Puts a shell tab the daemon just made at `placement`, showing it with the keyboard. */
  const showNew = (shell: Shell, placement: Placement) => {
    apply(shell);
    placeAndShow({ kind: 'shell', shellId: shell.id }, placement);
  };
  const paneOrFocused = (paneId: string | undefined) => (panes.some((pane) => pane.id === paneId) ? paneId! : focusedPane.id);
  const newTab = (paneId?: string, options?: { cwd?: string; script?: string }) => {
    if (shellsOf === undefined) return;
    const pane = paneOrFocused(paneId);
    run('open a shell', async () => showNew(await window.agentBoard.shells.createTab(shellsOf, options), { pane }));
  };
  const tabs = windowTabs(owner, owned);
  /** Ends a shell tab's shells, and with them the tab; or a shell tile's own panes, its next tab taking their place there. */
  const end = (surface: WindowSurface) => {
    if (surface.kind !== 'tab' || surface.tab.shell === undefined) return;
    const { shell } = surface.tab;
    if (surface.tab.id !== OWN_TAB) {
      run('close the tab', () => window.agentBoard.shells.delete(shell.id).then(() => {}));
      return;
    }
    // The tab that becomes the tile's own is its next, in their order: the own tab takes its place in the window.
    const next = tabs[1]?.id;
    const at = next === undefined ? undefined : placeOfSurface(working.current!, tabKey(next));
    run('close the tab', async () => {
      const { tile, promoted } = await window.agentBoard.shells.closeOwnPanes(shell.id);
      apply(tile);
      if (promoted !== next || at === undefined) return;
      const nextKey = tabKey(promoted);
      change((current) => {
        const without = paneOfSurface(current, nextKey) === undefined ? current : removeSurface(current, nextKey)!;
        const moved = paneOfSurface(without, at.placement.pane) === undefined ? without : placeSurface(without, { kind: 'own' }, at.placement, newId);
        return at.showing ? selectSurface(moved, OWN_SURFACE) : moved;
      });
    });
  };
  const shellStates = windowShells(owner, owned);
  const dots = new Map<string, ShellState>();
  for (const tab of tabs) {
    const worst = worstState(shellStates.filter((shell) => shell.tab === tab.id).map((shell) => shell.state));
    if (worst !== undefined) dots.set(tabKey(tab.id), worst);
  }
  const toasts = useToast();
  /** ⌘W on an agent's own tab: it can't be closed, and must not close the app's window instead. */
  const keepOwnTab = (repeat: boolean) => {
    if (!repeat) toasts.show({ tone: 'info', message: ownTabNotice(owner.kind === 'shell' ? 'shell' : 'agent') });
  };
  const closable = (surface: WindowSurface) => surface.kind !== 'tab' || surface.tab.id !== OWN_TAB || (owner.kind === 'shell' && tabs.length > 1);
  const close = (closeKey: string) => {
    const surface = byKey.get(closeKey);
    if (surface === undefined || !closable(surface)) return;
    if (surface.kind !== 'tab') {
      change((current) => removeSurface(current, closeKey));
      // A web tab's page goes, and its cookies and storage with it.
      if (surface.kind === 'web') window.agentBoard.webTabs.forget(surface.web.id).catch(() => {});
      return;
    }
    // Asked first while a shell in it runs, as deleting a shell tile is.
    if (tabLiveShells(surface.tab) > 0) setClosingKey(closeKey);
    else end(surface);
  };
  /** Says why, and returns true, when the pane drawn by `selector` is too small to split; a pane not drawn, or not showing, is let be. */
  const noRoom = (selector: string, direction: SplitDirection) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    // A pane mounted but hidden (a background tab) has no size to judge by.
    const why = box === undefined || box.width === 0 || box.height === 0 ? undefined : noRoomToSplit(box, direction, chosenFontSize() ?? DEFAULT_FONT_SIZE);
    if (why !== undefined) onProblem(why);
    return why !== undefined;
  };
  const split = (direction: SplitDirection, paneId?: string) => {
    if (shellsOf === undefined) return;
    const pane = paneOrFocused(paneId);
    if (noRoom(`[data-testid="window-pane"][data-pane="${CSS.escape(pane)}"]`, direction)) return;
    run('split', async () => showNew(await window.agentBoard.shells.createTab(shellsOf), { pane, edge: direction === 'horizontal' ? 'right' : 'bottom' }));
  };
  /** Splits the shell tile's own panes at its focused one, tmux-style, the new shell after it with the keyboard. */
  const splitTile = (surface: WindowSurface & { kind: 'tab' }, direction: SplitDirection) => {
    const shell = surface.tab.shell;
    const pane = focusIn(surface);
    if (shell === undefined || pane === undefined) return;
    if (noRoom(`[data-testid="shell-pane"][data-session-id="${CSS.escape(pane)}"]`, direction)) return;
    run('split', async () => {
      const before = paneIds(shell.layout);
      const changed = await window.agentBoard.shells.split(shell.id, pane, direction);
      apply(changed);
      const added = paneIds(changed.layout).find((id) => !before.includes(id));
      if (added !== undefined) setFocused((current) => ({ ...current, [surface.key]: added }));
    });
  };
  const shownNow = focusedPane.active;
  const splitFromDetails =
    shownNow.kind !== 'tab'
      ? undefined
      : (direction: SplitDirection) => (owner.kind === 'shell' && shownNow.key === OWN_SURFACE ? splitTile(shownNow, direction) : split(direction));
  const surfaceOf = (surfaceKeyOf: string) => byKey.get(surfaceKeyOf)?.surface;
  const shows = (surfaceKeyOf: string) => byKey.has(surfaceKeyOf);
  /** The move a drag from another window (or a pane of a split from this one) makes, dropped at `placement`; none for a shell into a tab window. */
  const moveOf = (drag: TabDrag, placement: Placement): TabMove | undefined =>
    moves === undefined
      ? undefined
      : drag.kind === 'surface'
        ? surfaceMoveInto(drag, named, shows, placement)
        : shellsOf === undefined
          ? undefined
          : dropMove(drag, { owner: shellsOf });
  const accepts = (drag: TabDrag) => draggedWithin(drag, named, surfaceOf) !== undefined || moveOf(drag, { pane: focusedPane.id }) !== undefined;

  const control: WindowPanesControl = {
    layout,
    holdsShells: shellsOf !== undefined,
    panes,
    surfaces,
    focusedPane,
    focusedSession: focusIn(focusedPane.active),
    focusIn,
    showing: (showKey) => paneOf(showKey)?.active.key === showKey,
    focus(sessionId) {
      const surface = [focusedPane.active, ...panes.map((pane) => pane.active), ...surfaces].find((each) => sessionsOf(each).includes(sessionId));
      if (surface === undefined) return;
      setFocused((current) => ({ ...current, [surface.key]: sessionId }));
      const pane = paneOf(surface.key);
      if (pane !== undefined && pane.active.key === surface.key) setFocusedPaneId(pane.id);
    },
    focusPane: setFocusedPaneId,
    select,
    closable,
    close,
    // Gone meanwhile (closed elsewhere, moved away), nothing waits.
    closing: closingKey === undefined ? undefined : byKey.get(closingKey),
    confirmClose(confirmed) {
      setClosingKey(undefined);
      const surface = closingKey === undefined ? undefined : byKey.get(closingKey);
      if (confirmed && surface !== undefined) end(surface);
    },
    newTab,
    newTabAt: (paneId) =>
      run('open a shell', async () => {
        if (shellsOf === undefined) return;
        const pane = paneOrFocused(paneId);
        const folder = await window.agentBoard.zones.browseFolder('Open a shell in');
        if (folder !== undefined) showNew(await window.agentBoard.shells.createTab(shellsOf, { cwd: folder }), { pane });
      }),
    scripts: () => (shellsOf === undefined ? Promise.resolve({ runner: 'npm', scripts: [] }) : window.agentBoard.shells.scripts(shellsOf)),
    sessionChoices: sessionChoices(owner, shown, { agents: agents ?? [], tiles: shells ?? [] }),
    showSession: (paneId, surface) => placeAndShow(surface, { pane: paneId }),
    open(surface, paneId) {
      const openKey = surfaceKey(surface);
      if (paneOf(openKey) !== undefined) select(openKey);
      else if (surface.kind !== 'own' && surface.kind !== 'shell') placeAndShow(surface, { pane: paneOrFocused(paneId) });
    },
    openWeb(url, paneId) {
      const open = surfaces.find((surface) => surface.kind === 'web' && surface.web.url === url && surface.web.private !== true);
      if (open !== undefined) select(open.key);
      else control.open({ kind: 'web', id: newId(), url }, paneId);
    },
    openBlankWeb(paneId, options) {
      const id = newId();
      newWebTabs.add(id);
      control.open(options?.private === true ? { kind: 'web', id, url: '', private: true } : { kind: 'web', id, url: '' }, paneId);
    },
    navigated: (web) => void change((current) => updateSurface(current, web)),
    localServers: localServersOf(shellStates),
    pullRequestChoices: pullRequestChoices(agents?.find((each) => owner.kind === 'agent' && each.sessionId === owner.agent.sessionId)?.pullRequests ?? [], shown),
    split,
    splitFromDetails,
    resize: async (splitId, ratio) => {
      change((current) => setSplitRatio(current, splitId, ratio));
    },
    accepts,
    drop(drag, placement) {
      const surface = draggedWithin(drag, named, surfaceOf);
      if (surface !== undefined) {
        placeAndShow(surface, placement);
        return;
      }
      const target = panes.find((pane) => pane.id === placement.pane);
      if (target !== undefined && givesUp(drag, placement, sessionsOf(target.active))) return;
      const move = moveOf(drag, placement);
      if (move === undefined) return;
      // The daemon moves a shell; this window lays it out where it was dropped once it hears of it. A tab that is only
      // a place in a window, the daemon lays out there itself.
      if (move.kind !== 'surface') expectArrival(move.kind === 'pane' ? move.sessionId : move.shellId, shellsOf!, placement);
      moves!(move);
    },
    dragOf: (surface) => surfaceDrag(surface.surface, named, { alone: tabs.length === 1, canMove: moves !== undefined }),
    apply,
    dots,
    onKeyDown(event) {
      // The close question's keys are its own: the dialog's events bubble here through its portal.
      if (closingKey !== undefined) return;
      const pressed = windowPaneKey(event.nativeEvent);
      if (pressed === undefined) return;
      // Before the terminal, and the board, whose ⌘D duplicates its selection, and the app menu, whose ⌘W closes the OS window.
      event.preventDefault();
      event.stopPropagation();
      // A tab with no ×, an agent's own, is not closed by ⌘W, nor is the window.
      if (pressed.kind === 'close' && !closable(focusedPane.active)) return keepOwnTab(event.repeat);
      // A held key opens one tab or split, and closes one tab.
      if (event.repeat && (pressed.kind === 'newTab' || pressed.kind === 'close' || pressed.kind === 'split')) return;
      act(pressed, focusedPane);
    },
    paneKey(paneId, key) {
      const pressed = windowPaneKey(key);
      if (pressed === undefined || closingKey !== undefined) return pressed !== undefined;
      const pane = panes.find((each) => each.id === paneId) ?? focusedPane;
      setFocusedPaneId(pane.id);
      if (pressed.kind !== 'close' || closable(pane.active)) act(pressed, pane);
      else keepOwnTab(false);
      return true;
    },
  };
  openRef.current = control.open;

  /** Does what one of the window's own keys asks, of `pane`. */
  function act(pressed: WindowPaneKey, pane: PaneView) {
    if (pressed.kind === 'focus') moveFocus(pressed.direction, pane);
    else if (pressed.kind === 'newTab') newTab(pane.id);
    else if (pressed.kind === 'close') close(pane.active.key);
    else if (pressed.kind === 'split') split(pressed.direction, pane.id);
    else {
      const surface = tabAtDigit(pane.surfaces, pressed.digit);
      if (surface !== undefined) select(surface.key);
    }
  }

  /**
   * Gives the keyboard to the nearest terminal that way: another pane's, or another pane of a split shell the focused
   * pane shows.
   */
  function moveFocus(direction: Direction, from: PaneView) {
    const slots = panes.flatMap((pane) => {
      const surface = pane.active;
      const inside = surface.kind === 'tab' ? surface.tab.layout : surface.kind === 'tile' ? surface.shell.layout : undefined;
      if (inside === undefined) return [{ pane: pane.id, surface, session: focusIn(surface), rect: pane.rect }];
      return paneGeometry(inside, bySession, pane.rect).panes.map(({ id, rect }) => ({ pane: pane.id, surface, session: id, rect }));
    });
    const at = slots.findIndex((slot) => slot.pane === from.id && (from.id !== focusedPane.id || slot.session === control.focusedSession));
    const to = nearestInDirection(
      slots.map((slot) => slot.rect),
      at,
      direction,
    );
    const slot = to === undefined ? undefined : slots[to];
    if (slot === undefined) return;
    setFocusedPaneId(slot.pane);
    if (slot.session !== undefined) setFocused((current) => ({ ...current, [slot.surface.key]: slot.session! }));
  }

  return control;
}

/** Where the surface is in the layout, as a placement that puts something in its place, and whether its pane shows it. */
function placeOfSurface(layout: WindowLayout, key: string): { placement: Placement; showing: boolean } | undefined {
  const pane = paneOfSurface(layout, key);
  if (pane === undefined) return undefined;
  return { placement: { pane: pane.id, index: pane.tabs.findIndex((tab) => surfaceKey(tab) === key) }, showing: pane.active === key };
}
