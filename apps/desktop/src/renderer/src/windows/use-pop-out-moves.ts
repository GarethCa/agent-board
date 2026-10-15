import { useEffect } from 'react';
import { errorMessage } from '../../../shared/errors';
import { isTyping } from '../board/use-tile-moves';
import { historyStep, inOverlay } from '../keys';
import { agentWorktrees, tabMover, useDragsFromOtherWindows, type TabMove } from '../session/shell-moves';
import { useLiveAgents } from '../session/use-live-board';

/**
 * Lets tabs drag to and from a popped-out window (slice 4). The board's window makes every move, so its one
 * undo history has them all: this window asks it to, through main (which opens the board's window first if it is
 * closed), and sends it ⌘Z and ⇧⌘Z when the keyboard isn't in a terminal or a field. After a move the keyboard leaves
 * this window's terminal, as it does the board's windows, so ⌘Z here takes the move back. `onProblem` hears why a move
 * or undo couldn't be asked for.
 */
export function usePopOutMoves(onProblem: (problem: string | undefined) => void): void {
  useDragsFromOtherWindows();
  useAgentWorktrees();

  useEffect(() => {
    tabMover.set((move: TabMove) => {
      onProblem(undefined);
      window.agentBoard.tabDrags.move(move).catch((error: unknown) => onProblem(`could not move the tab: ${errorMessage(error)}`));
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const step = historyStep(event);
      if (step === undefined || isTyping(event) || inOverlay()) return;
      event.preventDefault();
      window.agentBoard.tabDrags.history(step).catch((error: unknown) => onProblem(`could not ${step}: ${errorMessage(error)}`));
    };
    window.addEventListener('keydown', onKeyDown);
    const unsubscribe = window.agentBoard.tabDrags.onSettled(keyboardOffTerminal);
    return () => {
      tabMover.set(undefined);
      window.removeEventListener('keydown', onKeyDown);
      unsubscribe();
    };
  }, [onProblem]);
}

/**
 * Keeps `agentWorktrees` in this window, from the agents it hears of: the board's renderer keeps its own, and this
 * one's says whose worktree a shell moved in runs in.
 */
function useAgentWorktrees(): void {
  const { agents } = useLiveAgents();
  useEffect(() => agentWorktrees.set((agents ?? []).map(({ name, worktree }) => ({ name, worktree }))), [agents]);
}

/**
 * Takes the keyboard from this window's terminal, if this window has it, once the window a move changed has settled
 * (one whose tab went shows another, whose terminal would take it): ⌘Z then reaches the board's history.
 */
function keyboardOffTerminal(): void {
  if (!document.hasFocus()) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      // The whole page is the session window here, so anything in it gives the keyboard up, as on the board.
      if (active instanceof HTMLElement && active.closest('.session-window') !== null) active.blur();
    }),
  );
}
