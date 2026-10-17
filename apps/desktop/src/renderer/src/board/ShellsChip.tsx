import { useContext, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Plus } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Chip, Popover } from '../ui';
import { shellsChipLabel, type WindowShell } from '../session/tabs';
import { TileActionsContext } from './tile';

/** The most dots the chip draws; more are counted as "+N" after them (the footer's +N rule). */
const MAX_DOTS = 5;

/** How long the pointer may be off the chip and its list before the list closes: long enough to cross the gap. */
const CLOSE_DELAY_MS = 200;

/**
 * The shells chip on an agent's tile: "2 shells", with one dot per shell (green running a command, grey
 * idle, red failed). Hovering it, or clicking it, lists them with how each is doing and "+ New shell in this worktree";
 * a row opens the agent's session window on that shell's tab. Nothing for an agent with no shells. A shell never
 * changes the agent's state or joins Needs you. A badge of the tile's footer (`tileFooter`).
 */
export function ShellsChip({ agent, shells }: { agent: Agent; shells: readonly WindowShell[] }) {
  const { openTab } = useContext(TileActionsContext);
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  if (shells.length === 0) return null;
  const stay = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const leave = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const pick = (tab: string | undefined) => {
    setOpen(false);
    openTab(agent, tab);
  };
  const list = (
    <div className="tile-shells" onMouseEnter={stay} onMouseLeave={leave} data-testid="tile-shells-list">
      {shells.map((shell) => (
        <button key={shell.sessionId} type="button" className="tile-shells-row" data-testid="tile-shells-row" onClick={() => pick(shell.tab)}>
          <span className="tile-shells-dot" data-state={shell.state} aria-hidden />
          <span className="tile-shells-name">{shell.label}</span>
          <span className="tile-shells-meta" data-state={shell.state}>
            {stateText(shell)}
          </span>
        </button>
      ))}
      <button type="button" className="tile-shells-row tile-shells-new" onClick={() => pick(undefined)}>
        <Plus aria-hidden />
        New shell in this worktree
      </button>
    </div>
  );
  return (
    <Popover open={open} onOpenChange={setOpen} content={list} aria-label={`${agent.name}'s shells`} side="bottom" align="end" className="tile-shells-popover">
      <Chip
        className="hybrid-tile-shells nodrag"
        data-testid="tile-shells"
        aria-label={`${shellsChipLabel(shells.length)}: ${shells.map((shell) => `${shell.label}, ${stateText(shell)}`).join('; ')}`}
        onMouseEnter={stay}
        onMouseLeave={leave}
        onDoubleClick={stopPropagation}
      >
        {shellsChipLabel(shells.length)}
        <span className="tile-shells-dots" aria-hidden>
          {shells.slice(0, MAX_DOTS).map((shell) => (
            <span key={shell.sessionId} className="tile-shells-dot" data-state={shell.state} />
          ))}
          {shells.length > MAX_DOTS && <span className="tile-shells-more">+{shells.length - MAX_DOTS}</span>}
        </span>
      </Chip>
    </Popover>
  );
}

/** How a shell is doing, in words: running (on its ports), idle, its last command failed, or how it ended. */
export function stateText(shell: WindowShell): string {
  if (shell.exitCode !== undefined) return shell.exitCode === null ? 'ended by a signal' : `exit ${shell.exitCode}`;
  if (shell.failedCommand !== undefined) return `last command failed · exit ${shell.failedCommand}`;
  if (shell.ports !== undefined) return `running · ${shell.ports.map((port) => `:${port}`).join(' ')}`;
  return shell.state;
}

const stopPropagation = (event: MouseEvent) => event.stopPropagation();
