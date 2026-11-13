// The window's half of the menu bar: it tells main what its keys are and which can run here, which of its own commands
// it can run, and the menus of the agent and the project selected (shared/menu-bar.ts), and runs what is picked. A
// clicked key-registry item runs the action its owner gave (`setKey`), or else is pressed as its key, through the
// handler that key has. An accelerator is one key press, whichever of the menu and the window has it first: a press the
// window saw itself is not pressed again, and a press the menu ran first is kept from the window's handlers when it
// arrives. `createMenuBarBridge` is the logic, with the window's parts passed in so it is unit-tested; the hooks below
// use one per window, started from main.tsx.
import { useEffect, useRef } from 'react';
import { MENU_BAR_ACTIONS, type MenuBarAction, type MenuBarCommand, type MenuBarKey, type MenuBarRow, type MenuBarSection, type MenuBarState } from '../../../shared/menu-bar';
import type { ModelEntry } from '../board/menu-model';
import { isSimplified, observeRoot } from '../design';
import { extendedShortcuts, onExtendedShortcuts } from './extended-shortcuts';
import { menuBarKeys, menuBarRows, pressOf, runRow, type MenuBarWhere } from './menu-bar';
import { chordsOf, chordPressed, KEYS, type KeyBinding } from './registry';

/** How long apart the window's keydown and the menu's accelerator for the same key are one press, not two. */
const SAME_PRESS_MS = 1000;

/** What a press looks like to the bridge: the parts a chord is matched on. */
type Press = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export interface MenuBarWindow {
  isMac: boolean;
  /** The keys as they show now (the setting and the design read again), and which can run `where`. */
  /** The keys as the menu bar shows them, `where` the window is now; `runnable`, those the window runs on a click. */
  keys(where: MenuBarWhere, runnable: ReadonlySet<string>): Record<string, MenuBarKey>;
  /** Whether the focus is in a session window, or the window is one. */
  inSession(): boolean;
  /** Tells main the window's state. */
  report(state: MenuBarState): void;
  /** Presses a binding's key, where its handler hears it. */
  press(entry: KeyBinding): void;
  now(): number;
  /** Calls `run` soon, once however often it is asked before then. */
  later(run: () => void): void;
}

/** What a part of the window says it has, for the menu bar's items to follow: the board, a selection, an arrow selected. */
export type MenuBarCondition = 'board' | 'selection' | 'arrows';

export function createMenuBarBridge(window: MenuBarWindow) {
  const sections: Record<MenuBarSection, Map<symbol, { entries: readonly ModelEntry[]; rows: string }>> = { agent: new Map(), project: new Map() };
  const actions = new Map<MenuBarAction, { owner: symbol; run(): void; checked?: boolean }>();
  // A key's own action, run when its item is clicked, by the part that has it; the newest is the one run.
  const runners = new Map<string, Map<symbol, () => void>>();
  const conditions: Record<MenuBarCondition, Set<symbol>> = { board: new Set(), selection: new Set(), arrows: new Set() };
  // The last key press the window had from the user, and the last accelerator the menu ran before the window had it.
  let lastPress: { at: number; press: Press } | undefined;
  let menuPress: { at: number; entry: KeyBinding } | undefined;
  let sent: string | undefined;
  let queued = false;

  // The selection's menu: the last one set, as the newest selection is the one in front.
  const entriesOf = (section: MenuBarSection): readonly ModelEntry[] | undefined => [...sections[section].values()].at(-1)?.entries;
  const rowsOf = (section: MenuBarSection): MenuBarRow[] | null => {
    const entries = entriesOf(section);
    return entries === undefined ? null : menuBarRows(entries);
  };
  const where = (): MenuBarWhere => ({
    board: conditions.board.size > 0,
    selection: conditions.selection.size > 0,
    arrows: conditions.arrows.size > 0,
    session: window.inSession(),
  });

  const state = (): MenuBarState => ({
    keys: window.keys(where(), new Set([...runners].flatMap(([id, owners]) => (owners.size === 0 ? [] : [id])))),
    actions: Object.fromEntries(MENU_BAR_ACTIONS.flatMap((id) => {
      const action = actions.get(id);
      return action === undefined ? [] : [[id, action.checked === undefined ? {} : { checked: action.checked }]];
    })),
    agent: rowsOf('agent'),
    project: rowsOf('project'),
  });

  /** Tells main, if anything changed since it was last told, or always when `force`d (the window came to the front). */
  const report = (force = false) => {
    const next = state();
    const json = JSON.stringify(next);
    if (!force && json === sent) return;
    sent = json;
    window.report(next);
  };
  const changed = () => {
    if (queued) return;
    queued = true;
    window.later(() => {
      queued = false;
      report();
    });
  };

  const isPress = (entry: KeyBinding, press: Press) => chordsOf(entry, window.isMac).some((chord) => chordPressed(chord, press, window.isMac));
  const recent = (at: number) => window.now() - at < SAME_PRESS_MS;

  return {
    report,
    changed,
    /**
     * A key press the window had itself, from the user, before any handler. True when it is a press the menu has run
     * already, as its accelerator came first: the window's handlers must not run it again.
     */
    pressed(press: Press): boolean {
      if (menuPress !== undefined && recent(menuPress.at) && isPress(menuPress.entry, press)) {
        menuPress = undefined;
        return true;
      }
      lastPress = { at: window.now(), press: { key: press.key, code: press.code, metaKey: press.metaKey, ctrlKey: press.ctrlKey, shiftKey: press.shiftKey, altKey: press.altKey } };
      return false;
    },
    /** The agent's or the project's menu while `owner`'s is selected, or none. */
    setSection(section: MenuBarSection, owner: symbol, entries: readonly ModelEntry[] | undefined) {
      // A new one goes at the end, as the newest selected is the one shown; one already there keeps its place. A menu
      // made again with the same rows (each render) is kept for its actions, but tells main nothing.
      if (entries === undefined) {
        if (!sections[section].delete(owner)) return;
      } else {
        const rows = JSON.stringify(menuBarRows(entries));
        const was = sections[section].get(owner);
        sections[section].set(owner, { entries, rows });
        if (was?.rows === rows) return;
      }
      changed();
    },
    /** Says the window has `condition` while `owner` says so. */
    setWhen(condition: MenuBarCondition, owner: symbol, on: boolean) {
      const had = conditions[condition].has(owner);
      if (on === had) return;
      if (on) conditions[condition].add(owner);
      else conditions[condition].delete(owner);
      changed();
    },
    /** The action a key-registry item runs when clicked, while `owner` has it: for a key another item shares. */
    setKey(id: string, owner: symbol, run: (() => void) | undefined) {
      const owners = runners.get(id) ?? new Map<symbol, () => void>();
      const had = owners.size > 0;
      if (run === undefined) owners.delete(owner);
      else owners.set(owner, run);
      runners.set(id, owners);
      if (had !== owners.size > 0) changed();
    },
    /** One of the window's commands with no key, while `owner` can run it. */
    setAction(id: MenuBarAction, owner: symbol, action: { run(): void; checked?: boolean } | undefined) {
      if (action !== undefined) actions.set(id, { owner, ...action });
      else if (actions.get(id)?.owner === owner) actions.delete(id);
      changed();
    },
    /** Runs a picked item. */
    run(command: MenuBarCommand) {
      if (command.kind === 'action') return actions.get(command.id)?.run();
      if (command.kind === 'row') {
        const entries = entriesOf(command.section);
        if (entries !== undefined) runRow(entries, command.id);
        return;
      }
      const entry = KEYS.find((key) => key.id === command.id);
      if (entry === undefined) return;
      if (command.viaKey) {
        // The window had the press itself, and its handler ran then.
        if (lastPress !== undefined && recent(lastPress.at) && isPress(entry, lastPress.press)) {
          lastPress = undefined;
          return;
        }
        // The menu had it first: it is pressed where the key goes, and the window's own keydown, if it follows, is dropped.
        menuPress = { at: window.now(), entry };
        window.press(entry);
        return;
      }
      const run = [...(runners.get(entry.id)?.values() ?? [])].at(-1);
      if (run !== undefined) run();
      else window.press(entry);
    },
  };
}

export type MenuBarBridge = ReturnType<typeof createMenuBarBridge>;

/** Where a pressed key goes: the board's keys to the board; a window's to what has the focus, unless that is a terminal. */
function pressTarget(entry: KeyBinding): EventTarget {
  if (entry.scope === 'board' || entry.scope === 'tile') return document.body;
  const active = document.activeElement;
  // A terminal would type the key: its own element takes it instead, where the window's handlers still hear it.
  return active?.closest('.xterm')?.parentElement ?? active ?? document.body;
}

const isMac = navigator.platform.startsWith('Mac');
/** A session window, on the board or as a window of its own. */
const SESSION_WINDOW = '.session-window';
const OWN_SESSION_WINDOW = '.session-window-own-window';
let bridge: MenuBarBridge | undefined;

/** Starts the window's half of the menu bar, for a window with the app's preload. */
export function startMenuBar(): void {
  const api = window.agentBoard.menuBar;
  bridge = createMenuBarBridge({
    isMac,
    keys: (where, runnable) => menuBarKeys(isMac, extendedShortcuts(), isSimplified(), where, runnable),
    inSession: () => document.activeElement?.closest(SESSION_WINDOW) != null || document.querySelector(OWN_SESSION_WINDOW) !== null,
    report: (state) => api.report(state),
    press: (entry) => pressTarget(entry).dispatchEvent(new KeyboardEvent('keydown', pressOf(entry, isMac))),
    now: () => performance.now(),
    later: (run) => void setTimeout(run, 50),
  });
  const started = bridge;
  api.onRun((command) => started.run(command));
  // Before any handler, which may stop it: added at start, it is the window's first. A press the menu has run already
  // goes no further.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || !started.pressed(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener('focus', () => started.report(true));
  // Where the focus is says which keys run: a session window's, or the board's.
  document.addEventListener('focusin', started.changed);
  document.addEventListener('focusout', started.changed);
  onExtendedShortcuts(started.changed);
  observeRoot('data-design')(started.changed);
  started.report(true);
}

/** Puts the selected agent's or project's menu (a model menu) in the menu bar while `selected`. */
export function useMenuBarSection(section: MenuBarSection, selected: boolean, entries: readonly ModelEntry[]): void {
  const owner = useRef(Symbol(section)).current;
  useEffect(() => {
    if (!selected) return;
    bridge?.setSection(section, owner, entries);
  }, [section, owner, selected, entries]);
  useEffect(() => {
    if (selected) return () => bridge?.setSection(section, owner, undefined);
  }, [section, owner, selected]);
}

/** Lets the menu bar run one of the window's own commands while the component is shown, ticked when `checked`. */
export function useMenuBarAction(id: MenuBarAction, run: () => void, checked?: boolean): void {
  const owner = useRef(Symbol(id)).current;
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    bridge?.setAction(id, owner, { run: () => latest.current(), ...(checked === undefined ? {} : { checked }) });
  }, [id, owner, checked]);
  useEffect(() => () => bridge?.setAction(id, owner, undefined), [id, owner]);
}

/** Tells the menu bar the window has `condition` while `on`, for its items to grey or not. */
export function useMenuBarWhen(condition: MenuBarCondition, on: boolean): void {
  const owner = useRef(Symbol(condition)).current;
  useEffect(() => {
    bridge?.setWhen(condition, owner, on);
  }, [condition, owner, on]);
  useEffect(() => () => bridge?.setWhen(condition, owner, false), [condition, owner]);
}

/**
 * Gives the key-registry item `id` the action its click runs, while the component is shown, rather than its key being
 * pressed: for a key another item shares (⌘D, ⌘[ ⌘]), whose press could reach another handler first.
 */
export function useMenuBarKey(id: string, run: () => void): void {
  const owner = useRef(Symbol(id)).current;
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    bridge?.setKey(id, owner, () => latest.current());
    return () => bridge?.setKey(id, owner, undefined);
  }, [id, owner]);
}
