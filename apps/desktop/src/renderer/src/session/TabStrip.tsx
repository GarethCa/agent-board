import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Columns2, EyeOff, FolderOpen, GitPullRequest, Globe, PanelsTopLeft, Play, Plus, SquareCheckBig, SquareTerminal, X } from 'lucide-react';
import type { PackageScripts } from '@agent-board/daemon/protocol';
import { useSimplified } from '../design';
import { binding, chordText, keyText } from '../keys/registry';
import { Button, IconButton, Kbd, Menu, type MenuEntry } from '../ui';
import type { AttachState } from './TerminalPane';
import type { ShellState } from './tabs';

/** A Gate tab's dot: spinning while its run runs, then green or red; idle with none, or stopped. */
export type GateDot = 'gate-running' | 'gate-passed' | 'gate-failed';
import { dragKey, dropTaken, endDrag, tabDrag, startDrag, useTabDrag, type TabDrag } from './shell-moves';

export interface StripTab {
  id: string;
  label: string;
  /** Its dot: how an agent's own pane is attached, how its shells are doing, or how a gate's run is. */
  dot?: AttachState | ShellState | GateDot;
  /** An icon in place of its dot, for a tab that shows no session: a pull request's. */
  icon?: ReactNode;
  /** What its tooltip names it, where its label alone may not tell it apart: a pull request's `owner/repo#N`. */
  title?: string;
  /** A tab can be closed (its ×, a middle-click, ⌘W): every one but an agent's own. */
  closable: boolean;
  /** What its × says it does. */
  closeHint: string;
  /** What leads it, before its label, in place of its dot: an agent's character. */
  lead?: ReactNode;
  /** A word in a pill after its label: a ticket's chat's "chat", or the side of a split it shows on. */
  pill?: string;
  /** On as well as the tab that is, in the other pane of a split. */
  beside?: boolean;
  /** What ends it, after its label: an agent's status dot, with a tooltip of its own. */
  mark?: ReactNode;
  /** Whether its agent asks for the user, which colours it as an ask. */
  ask?: boolean;
  /** What stands in place of its label while it is renamed in place: its name field. */
  editing?: ReactNode;
}

interface TabStripProps {
  tabs: StripTab[];
  active: string;
  /** Whether its pane has the keyboard, of several. */
  focused?: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
  /** The id of the panel that shows a tab, for its `aria-controls`. */
  panelId(tabId: string): string;
  /** What the tab drags as; undefined for one that stays put, and for every tab where nothing drags. */
  dragOf?(tabId: string): TabDrag | undefined;
  /** What the strip does with a tab or pane dropped on it at `index` among its tabs, if it would take it. */
  drop?: { accepts(drag: TabDrag): boolean; onDrop(drag: TabDrag, index: number): void };
  /** What ⌥-click on a tab does in place of picking it: opens its agent in a window of its own. */
  onAltSelect?(id: string): void;
  /** What the tab list is named, for a screen reader. */
  label?: string;
  /**
   * What + (⌘T) offers, and Split (⌘D): new shells, scripts, other sessions. Undefined for a strip of a fixed set of
   * tabs, a ticket's pop-up's, which has neither, and whose tabs name no ⌘1–9.
   */
  adds?: TabAdds;
  /** Whatever sits at the strip's right end, after Split: the agent's Terminal / Chat switch. */
  trailing?: ReactNode;
  /**
   * Given, every tab drags along the strip, and only along it: dropped at `index` (as `drop` counts it, the tab still in
   * place), it moves there. Dropped anywhere else it stays put. A pop-up's row has it in place of `dragOf`.
   */
  reorder?(id: string, index: number): void;
  /** The tab the user came from, underlined so one click (or ⌘[) goes back to it. */
  from?: string | undefined;
  /** What a right-click on a tab opens at the pointer, its menu; undefined for a tab with none, and where tabs have none. */
  onContextMenu?(id: string, at: { x: number; y: number }): boolean;
}

/** What a tab dragged along a strip that reorders carries: its own type, so nothing else (the board, a window) takes it. */
/** What a tab of a reorderable row carries as it is dragged: its id. A pop-up's panes take it too, to show it there. */
export const ROW_TAB_TYPE = 'application/x-agent-board-row-tab';

/** What a session window's strip adds: its + menu, and Split. */
export interface TabAdds {
  /** A new shell where the agent started, or in the shell tile's folder (⌘T). */
  onNewShell(): void;
  /** Where that is, as its menu entry says: "in this worktree", "in this folder". */
  here: string;
  /** A new shell in a folder the user picks. */
  onNewShellAt(): void;
  onRunScript(script: string): void;
  /** The scripts of the agent's folder, looked up as the + menu opens. */
  scripts(): Promise<PackageScripts>;
  /** The other agents and shell tiles the + menu offers to show as a tab here. */
  sessions: { label: string; onSelect(): void }[];
  /** The agent's pull requests the + menu offers to open as a tab here. */
  pullRequests?: { label: string; onSelect(): void }[];
  /** Opens the agent's to-do list as a tab here: undefined where there is none to open. */
  onOpenTodo?(): void;
  /** Asks for a page to open in a web tab here: the + menu's "Web…", or its "Private web…" for a `private` one. */
  onOpenWeb?(options?: { private?: boolean }): void;
  /** Named "Shell", not just +, while the window has no tab but its own, so the way to one is plain to see. */
  named: boolean;
  /** Whether + offers shells and Split makes one: not in a tab window (slice 4), which holds none. True by default. */
  shells?: boolean;
  /** Splits the pane, a new shell tab beside it (⌘D). */
  onSplit(): void;
}

/**
 * One pane's strip of tabs in a session window, with + (⌘T) for a new shell, at
 * a folder, running a package script, or showing another session, and Split (⌘D) for a new pane beside it. ⌘1–9
 * switch. A tab closes by its ×, shown on hover and on the tab showing, or a middle-click. A tab dragged along the
 * strip, from another, or from another window lands where a slot shows.
 */
export function TabStrip({ tabs, active, focused = false, onSelect, onAltSelect, onClose, label = 'Terminal tabs', adds, panelId, dragOf, drop, trailing, reorder, from, onContextMenu }: TabStripProps) {
  const list = useRef<HTMLDivElement>(null);
  // A tab or pane held over the strip that would land here shows a slot where it would go.
  const dragging = useTabDrag();
  /** The tab dragged along the strip to move it, where its tabs reorder (`reorder`). */
  const [moving, setMoving] = useState<string>();
  const accepting = moving !== undefined || (dragging !== undefined && drop?.accepts(dragging) === true);
  /** Where among the tabs a drag held over the strip would land, if one is. */
  const [over, setOver] = useState<number>();
  useEffect(() => {
    if (dragging === undefined && moving === undefined) setOver(undefined);
  }, [dragging, moving]);
  /** The index the pointer is at among the tabs: before the first whose middle is right of it. */
  const indexAt = (clientX: number) => {
    const placed = [...(list.current?.querySelectorAll<HTMLElement>('[data-testid="session-tab"]') ?? [])];
    const at = placed.findIndex((tab) => {
      const box = tab.getBoundingClientRect();
      return clientX < box.left + box.width / 2;
    });
    return at === -1 ? placed.length : at;
  };
  // The tab showing is scrolled into view, however it was picked (⌘9, a chip's row).
  useEffect(() => {
    // A block, not an expression: Chromium's scrollIntoView returns a promise, which React would take for a cleanup.
    void list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  /** ← → Home End move between the tabs, picking each, as a tab list's keys do; one tab is a Tab stop. */
  const move = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const to =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    onSelect(tabs[to]!.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  const slot = over !== undefined && accepting ? <span className="session-tab-slot" data-testid="session-tab-slot" aria-hidden /> : null;
  return (
    <div
      className="session-tabs"
      data-testid="session-tabs"
      data-focused={focused || undefined}
      data-drop-over={(over !== undefined && accepting) || undefined}
      onDragOver={(event) => {
        if (!accepting) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(indexAt(event.clientX));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
      }}
      onDrop={(event) => {
        if (moving !== undefined && reorder !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          setOver(undefined);
          setMoving(undefined);
          reorder(moving, indexAt(event.clientX));
          return;
        }
        const drag = tabDrag();
        if (drag === undefined || drop === undefined || !drop.accepts(drag)) return;
        // The strip's, not the board's under it.
        event.preventDefault();
        event.stopPropagation();
        setOver(undefined);
        dropTaken();
        drop.onDrop(drag, indexAt(event.clientX));
      }}
    >
      <div ref={list} className="session-tabs-list" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map((tab, index) => {
          const drag = dragOf?.(tab.id);
          const moves = reorder !== undefined;
          return (
            <Fragment key={tab.id}>
              {over === index && slot}
              <span
                className={drag === undefined && !moves ? 'session-tab' : 'session-tab nodrag'}
                data-active={tab.id === active || undefined}
                data-beside={(tab.beside && tab.id !== active) || undefined}
                data-from={(tab.id === from && tab.id !== active) || undefined}
                data-ask={tab.ask || undefined}
                data-testid="session-tab"
                data-tab={tab.id}
                data-dragging={(drag !== undefined && dragging !== undefined && dragKey(dragging) === dragKey(drag)) || moving === tab.id || undefined}
                draggable={drag !== undefined || moves}
                onDragStart={
                  moves
                    ? (event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData(ROW_TAB_TYPE, tab.id);
                        setMoving(tab.id);
                      }
                    : drag === undefined
                      ? undefined
                      : (event) => startDrag(event, drag, tab.label)
                }
                onDragEnd={moves ? () => setMoving(undefined) : drag === undefined ? undefined : (event) => endDrag(event, drag)}
                // A middle-click closes a shell tab, as in a browser; held down, it neither scrolls nor pastes.
                onMouseDown={tab.closable ? (event) => event.button === 1 && event.preventDefault() : undefined}
                onContextMenu={
                  onContextMenu === undefined
                    ? undefined
                    : (event) => {
                        if (!onContextMenu(tab.id, { x: event.clientX, y: event.clientY })) return;
                        event.preventDefault();
                        event.stopPropagation();
                      }
                }
                onAuxClick={
                  tab.closable
                    ? (event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        onClose(tab.id);
                      }
                    : undefined
                }
              >
                {tab.editing ?? (
                <button
                  type="button"
                  role="tab"
                  className="session-tab-button"
                  aria-selected={tab.id === active}
                  aria-controls={panelId(tab.id)}
                  tabIndex={tab.id === active ? 0 : -1}
                  title={adds !== undefined && index < 9 ? `${tab.title ?? tab.label} (${chordText({ ...binding('window.tab').keys[0]!, text: String(index + 1) })})` : (tab.title ?? tab.label)}
                  onClick={(event) => (event.altKey && onAltSelect !== undefined ? onAltSelect(tab.id) : onSelect(tab.id))}
                >
                  {tab.lead !== undefined ? (
                    <span className="session-tab-lead" aria-hidden>
                      {tab.lead}
                    </span>
                  ) : tab.icon === undefined ? (
                    <span className="session-window-pane-dot" data-state={tab.dot} aria-hidden />
                  ) : (
                    <span className="session-tab-icon" aria-hidden>
                      {tab.icon}
                    </span>
                  )}
                  <span className="session-tab-label">{tab.label}</span>
                  {tab.pill !== undefined && <span className="session-tab-pill">{tab.pill}</span>}
                </button>
                )}
                {tab.mark}
                {tab.closable && (
                  <IconButton
                    className="session-tab-close"
                    icon={<X />}
                    size="xs"
                    variant="ghost"
                    aria-label={`Close ${tab.label}`}
                    tooltip={tab.closeHint}
                    onClick={() => onClose(tab.id)}
                  />
                )}
              </span>
            </Fragment>
          );
        })}
        {over !== undefined && over >= tabs.length && slot}
      </div>
      {adds !== undefined && <AddTabs {...adds} />}
      {trailing}
    </div>
  );
}

/**
 * What a + offers for a pane: shells here or at a folder, web pages, the folder's scripts (looked up as the menu opens),
 * other sessions, the pull requests and the to-do list, and Split under the Simplified design. `onOpenChange` is the
 * menu's, to start the lookup. With `split` false it leaves Split to whoever offers its own.
 */
export function useAddEntries({ onNewShell, here, onNewShellAt, onRunScript, scripts, sessions, pullRequests = [], onOpenTodo, onOpenWeb, shells = true, onSplit }: TabAdds, { split = true } = {}): {
  entries: MenuEntry[];
  menuOpen: boolean;
  onOpenChange(open: boolean): void;
} {
  const simplified = useSimplified();
  const [menuOpen, setMenuOpen] = useState(false);
  const [found, setFound] = useState<PackageScripts | 'looking' | 'failed'>('looking');
  const openMenu = (open: boolean) => {
    setMenuOpen(open);
    if (!open) return;
    if (!shells) return;
    setFound('looking');
    scripts().then(setFound, () => setFound('failed'));
  };
  const scriptEntries: MenuEntry[] =
    found === 'looking'
      ? [{ label: 'Looking for scripts…', disabled: true, onSelect: () => {} }]
      : found === 'failed' || found.scripts.length === 0
        ? [{ label: found === 'failed' ? 'Could not read package.json' : 'No package.json scripts here', disabled: true, onSelect: () => {} }]
        : found.scripts.map((script) => ({ label: script, icon: <Play />, hint: `${found.runner} run ${script}`, onSelect: () => onRunScript(script) }));
  const shellEntries: MenuEntry[] = [
    { label: `New shell ${here}`, icon: <SquareTerminal />, shortcut: keyText('window.newTab'), onSelect: onNewShell },
    { label: 'New shell at a folder…', icon: <FolderOpen />, onSelect: onNewShellAt },
  ];
  // Under the Simplified design the menu says where its entries open, and holds Split, in place of the strip's icon.
  const entries: MenuEntry[] = [
    ...(simplified ? ([{ heading: 'Open in this pane' }] as MenuEntry[]) : []),
    ...(shells ? shellEntries : []),
    ...(onOpenWeb === undefined
      ? []
      : [
          { label: 'Web…', icon: <Globe />, hint: 'A dev server, or an https page', onSelect: () => onOpenWeb() },
          { label: 'Private web…', icon: <EyeOff />, hint: 'Keeps no login or cookie past the tab', onSelect: () => onOpenWeb({ private: true }) },
        ]),
    ...(shells ? (['separator', { heading: 'Run a script' }, ...scriptEntries] as MenuEntry[]) : []),
    ...(sessions.length === 0 ? [] : (['separator', { heading: 'Show a session' }] as MenuEntry[])),
    ...sessions.map((session): MenuEntry => ({ label: session.label, icon: <PanelsTopLeft />, onSelect: session.onSelect })),
    ...(pullRequests.length === 0 ? [] : (['separator', { heading: 'Open a pull request' }] as MenuEntry[])),
    ...pullRequests.map((pr): MenuEntry => ({ label: pr.label, icon: <GitPullRequest />, onSelect: pr.onSelect })),
    ...(onOpenTodo === undefined ? [] : (['separator', { label: 'To-do list', icon: <SquareCheckBig />, hint: 'Its reminders for you', onSelect: onOpenTodo }] as MenuEntry[])),
    ...(simplified && shells && split ? (['separator', { heading: 'Split' }, { label: 'Split right', icon: <Columns2 />, shortcut: keyText('window.splitBeside'), onSelect: onSplit }] as MenuEntry[]) : []),
  ];
  return { entries, menuOpen, onOpenChange: openMenu };
}

/** A session window's + (⌘T), named Shell while it has no tab but its own, and Split (⌘D). */
function AddTabs(adds: TabAdds) {
  const { named, shells = true, onSplit } = adds;
  const simplified = useSimplified();
  const { entries, menuOpen, onOpenChange: openMenu } = useAddEntries(adds);
  return (
    <>
      <Menu entries={entries} open={menuOpen} onOpenChange={openMenu}>
        {/* Named while the window has no shell tabs yet, so the way to one is plain to see. */}
        <Button
          size="xs"
          variant="ghost"
          className="session-tab-new"
          icon={<Plus />}
          aria-label="New tab"
          tooltip={
            <>
              New shell tab<Kbd>{keyText('window.newTab')}</Kbd>
            </>
          }
        >
          {named ? 'Shell' : undefined}
        </Button>
      </Menu>
      {shells && !simplified && (
        <IconButton
          className="session-tab-split"
          icon={<Columns2 />}
          size="xs"
          variant="ghost"
          aria-label="Split pane"
          tooltip={
            <>
              Split: a new shell beside this pane
              <Kbd>{keyText('window.splitBeside')}</Kbd>
            </>
          }
          onClick={onSplit}
        />
      )}
    </>
  );
}
