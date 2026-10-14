// Where a tab arriving in a window lands (BH1): moves between windows are the daemon's (`shell.moveTab`,
// `shell.movePane`), and the window the tab lands in lays it out once it hears of it. A drop says where it should go
// beforehand, and a window remembers where each tab it lost was, so an undo puts it back there.
import { paneIds } from '@agent-board/daemon/pane-layout';
import type { Shell, ShellOwner } from '@agent-board/daemon/protocol';
import { surfaceKey, windowPanes, type Placement, type WindowLayout } from '@agent-board/daemon/window-layout';
import { dropKey } from './shell-moves';

/** Where a dropped tab goes in the window it was dropped on, by the shell's id or, for a pane, its session's. */
const arriving = new Map<string, { owner: string; placement: Placement }>();
/** Where each shell tab was in each window it left, by the window's drop key and the shell's id. */
const departed = new Map<string, Placement>();

const departedKey = (owner: ShellOwner, shellId: string) => `${dropKey(owner)}|${shellId}`;

/** Says where the shell `id` (or the shell a pane with that session id becomes) lands in the owner's window, once it arrives. */
export function expectArrival(id: string, owner: ShellOwner, placement: Placement): void {
  arriving.set(id, { owner: dropKey(owner), placement });
}

/**
 * Where the shell, now one of the owner's tabs, goes in its window: where it was dropped, else where it last was there.
 * Read as the window lays it out, which may happen more than once; `settleArrival` forgets it once it is laid out.
 */
export function arrivalPlacement(owner: ShellOwner, shell: Shell): Placement | undefined {
  for (const id of [shell.id, ...paneIds(shell.layout)]) {
    const expected = arriving.get(id);
    if (expected?.owner === dropKey(owner)) return expected.placement;
  }
  return departed.get(departedKey(owner, shell.id));
}

/** Forgets where the shell was to land in the owner's window: it is laid out there now. */
export function settleArrival(owner: ShellOwner, shell: Shell): void {
  for (const id of [shell.id, ...paneIds(shell.layout)]) if (arriving.get(id)?.owner === dropKey(owner)) arriving.delete(id);
  departed.delete(departedKey(owner, shell.id));
}

/** Remembers where each shell tab `before` held, and `after` doesn't, was in the owner's window. */
export function noteDepartures(owner: ShellOwner, before: WindowLayout, after: WindowLayout): void {
  const kept = new Set(windowPanes(after).flatMap((pane) => pane.tabs.map(surfaceKey)));
  for (const pane of windowPanes(before)) {
    pane.tabs.forEach((tab, index) => {
      if (tab.kind === 'shell' && !kept.has(surfaceKey(tab))) departed.set(departedKey(owner, tab.shellId), { pane: pane.id, index });
    });
  }
}
