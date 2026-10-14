import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Columns2, FolderOpen, PanelsTopLeft, Play, Plus, SquareTerminal, X } from 'lucide-react';
import type { PackageScripts } from '@agent-board/daemon/protocol';
import { withWindowShortcut } from '../keys';
import { Button, IconButton, Kbd, Menu, type MenuEntry } from '../ui';
import type { AttachState } from './TerminalPane';
import type { ShellState } from './tabs';
import { dragKey, setShellDrag, SHELL_DRAG_TYPE, shellDrag, startDrag, useShellDrag, type ShellDrag } from './shell-moves';

export interface StripTab {
  id: string;
  label: string;
  /** Its dot: how an agent's own pane is attached, or how its shells are doing. */
  dot: AttachState | ShellState;
  /** A tab can be closed (its ×, a middle-click, ⌘W): every one but an agent's own. */
  closable: boolean;
  /** What its × says it does. */
  closeHint: string;
}

interface TabStripProps {
  tabs: StripTab[];
  active: string;
  /** Whether its pane has the keyboard, of several. */
  focused?: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
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
  /** Named "Shell", not just +, while the window has no tab but its own, so the way to one is plain to see. */
  named: boolean;
  /** Splits the pane, a new shell tab beside it (⌘D). */
  onSplit(): void;
  /** The id of the panel that shows a tab, for its `aria-controls`. */
  panelId(tabId: string): string;
  /** What the tab drags as (AT2); undefined for one that stays put, and for every tab where nothing drags. */
  dragOf?(tabId: string): ShellDrag | undefined;
  /** What the strip does with a tab or pane dropped on it at `index` among its tabs, if it would take it. */
  drop?: { accepts(drag: ShellDrag): boolean; onDrop(drag: ShellDrag, index: number): void };
}

/**
 * One pane's strip of tabs in a session window (BH1), cmux-style, with + (⌘T) for a new shell, at
 * a folder, running a package script, or showing another session, and Split (⌘D) for a new pane beside it. ⌘1–9
 * switch. A tab closes by its ×, shown on hover and on the tab showing, or a middle-click. A tab dragged along the
 * strip, from another, or from another window lands where a slot shows.
 */
export function TabStrip({
  tabs,
  active,
  focused = false,
  onSelect,
  onClose,
  onNewShell,
  here,
  onNewShellAt,
  onRunScript,
  scripts,
  sessions,
  named,
  onSplit,
  panelId,
  dragOf,
  drop,
}: TabStripProps) {
  const list = useRef<HTMLDivElement>(null);
  // A tab or pane held over the strip that would land here shows a slot where it would go.
  const dragging = useShellDrag();
  const accepting = dragging !== undefined && drop?.accepts(dragging) === true;
  /** Where among the tabs a drag held over the strip would land, if one is. */
  const [over, setOver] = useState<number>();
  useEffect(() => {
    if (dragging === undefined) setOver(undefined);
  }, [dragging]);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [found, setFound] = useState<PackageScripts | 'looking' | 'failed'>('looking');
  const openMenu = (open: boolean) => {
    setMenuOpen(open);
    if (!open) return;
    setFound('looking');
    scripts().then(setFound, () => setFound('failed'));
  };
  const scriptEntries: MenuEntry[] =
    found === 'looking'
      ? [{ label: 'Looking for scripts…', disabled: true, onSelect: () => {} }]
      : found === 'failed' || found.scripts.length === 0
        ? [{ label: found === 'failed' ? 'Could not read package.json' : 'No package.json scripts here', disabled: true, onSelect: () => {} }]
        : found.scripts.map((script) => ({ label: script, icon: <Play />, hint: `${found.runner} run ${script}`, onSelect: () => onRunScript(script) }));
  const entries: MenuEntry[] = [
    { label: `New shell ${here}`, icon: <SquareTerminal />, shortcut: withWindowShortcut('T'), onSelect: onNewShell },
    { label: 'New shell at a folder…', icon: <FolderOpen />, onSelect: onNewShellAt },
    'separator',
    { heading: 'Run a script' },
    ...scriptEntries,
    ...(sessions.length === 0 ? [] : (['separator', { heading: 'Show a session' }] as MenuEntry[])),
    ...sessions.map((session): MenuEntry => ({ label: session.label, icon: <PanelsTopLeft />, onSelect: session.onSelect })),
  ];
  const slot = over !== undefined && accepting ? <span className="session-tab-slot" data-testid="session-tab-slot" aria-hidden /> : null;
  return (
    <div
      className="session-tabs"
      data-testid="session-tabs"
      data-focused={focused || undefined}
      data-drop-over={(over !== undefined && accepting) || undefined}
      onDragOver={(event) => {
        if (!accepting || !event.dataTransfer.types.includes(SHELL_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(indexAt(event.clientX));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
      }}
      onDrop={(event) => {
        const drag = shellDrag();
        if (drag === undefined || drop === undefined || !drop.accepts(drag)) return;
        // The strip's, not the board's under it.
        event.preventDefault();
        event.stopPropagation();
        setOver(undefined);
        setShellDrag(undefined);
        drop.onDrop(drag, indexAt(event.clientX));
      }}
    >
      <div ref={list} className="session-tabs-list" role="tablist" aria-label="Terminal tabs" onKeyDown={move}>
        {tabs.map((tab, index) => {
          const drag = dragOf?.(tab.id);
          return (
            <Fragment key={tab.id}>
              {over === index && slot}
              <span
                className={drag === undefined ? 'session-tab' : 'session-tab nodrag'}
                data-active={tab.id === active || undefined}
                data-testid="session-tab"
                data-tab={tab.id}
                data-dragging={(drag !== undefined && dragging !== undefined && dragKey(dragging) === dragKey(drag)) || undefined}
                draggable={drag !== undefined}
                onDragStart={drag === undefined ? undefined : (event) => startDrag(event, drag, tab.label)}
                onDragEnd={drag === undefined ? undefined : () => setShellDrag(undefined)}
                // A middle-click closes a shell tab, as in a browser; held down, it neither scrolls nor pastes.
                onMouseDown={tab.closable ? (event) => event.button === 1 && event.preventDefault() : undefined}
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
                <button
                  type="button"
                  role="tab"
                  className="session-tab-button"
                  aria-selected={tab.id === active}
                  aria-controls={panelId(tab.id)}
                  tabIndex={tab.id === active ? 0 : -1}
                  title={index < 9 ? `${tab.label} (${withWindowShortcut(String(index + 1))})` : tab.label}
                  onClick={() => onSelect(tab.id)}
                >
                  <span className="session-window-pane-dot" data-state={tab.dot} aria-hidden />
                  <span className="session-tab-label">{tab.label}</span>
                </button>
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
              New shell tab<Kbd>{withWindowShortcut('T')}</Kbd>
            </>
          }
        >
          {named ? 'Shell' : undefined}
        </Button>
      </Menu>
      <IconButton
        className="session-tab-split"
        icon={<Columns2 />}
        size="xs"
        variant="ghost"
        aria-label="Split pane"
        tooltip={
          <>
            Split: a new shell beside this pane
            <Kbd>{withWindowShortcut('D')}</Kbd>
          </>
        }
        onClick={onSplit}
      />
    </div>
  );
}
