import { app, ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateShellTileParams, PaneLayout, ShellOwner, ShellPlace, SplitDirection, TileMove, WindowOwner } from '@agent-board/daemon/protocol';
import type { Placement, Surface, WindowLayout } from '@agent-board/daemon/window-layout';
import { SHELL_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough, passthroughVoid } from './passthrough';

/** The shell tile IPC the preload's `shells` API calls. Every window hears every change, so tiles stay live. */
export function registerShellIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['shell.updated', 'shell.removed'], SHELL_IPC.changed);
  forwardEvents(daemon, ['window.layout'], SHELL_IPC.layoutChanged);

  passthrough(daemon, SHELL_IPC.list, 'shell.list');
  passthrough(daemon, SHELL_IPC.createTab, 'shell.createTab', (owner: ShellOwner, options?: { cwd?: unknown; script?: unknown }) => ({
    owner,
    ...(typeof options?.cwd === 'string' ? { cwd: options.cwd } : {}),
    ...(typeof options?.script === 'string' ? { script: options.script } : {}),
  }));
  passthrough(daemon, SHELL_IPC.ownTab, 'shell.ownTab', (agentId: string) => ({ agentId }));
  passthrough(daemon, SHELL_IPC.scripts, 'shell.scripts', (owner: ShellOwner) => ({ owner }));
  passthrough(daemon, SHELL_IPC.create, 'shell.create', (params: CreateShellTileParams) => params);
  passthrough(daemon, SHELL_IPC.move, 'shell.move', (shellId: string, move: TileMove) => ({ ...move, shellId }));
  passthrough(daemon, SHELL_IPC.moveTab, 'shell.moveTab', (shellId: string, to: ShellPlace, order?: number | null) => ({
    shellId,
    to,
    ...(order === undefined ? {} : { order }),
  }));
  passthrough(daemon, SHELL_IPC.movePane, 'shell.movePane', (shellId: string, sessionId: string, to: ShellPlace, id?: string) => ({
    shellId,
    sessionId,
    to,
    ...(typeof id === 'string' ? { id } : {}),
  }));
  passthrough(daemon, SHELL_IPC.returnPane, 'shell.returnPane', (shellId: string, sessionId: string, layout: PaneLayout) => ({ shellId, sessionId, layout }));
  passthrough(daemon, SHELL_IPC.windowLayout, 'shell.windowLayout', (owner: WindowOwner) => ({ owner }));
  passthrough(daemon, SHELL_IPC.unsplitTabs, 'shell.unsplitTabs', (owner: WindowOwner) => ({ owner }));
  passthrough(daemon, SHELL_IPC.setWindowLayout, 'shell.setWindowLayout', (owner: WindowOwner, layout: WindowLayout, base?: WindowLayout | null) => ({
    owner,
    layout,
    ...(base === undefined ? {} : { base }),
  }));
  passthrough(
    daemon,
    SHELL_IPC.moveSurface,
    'shell.moveSurface',
    (surface: Surface, from: WindowOwner | null, to: { owner: WindowOwner; placement?: Placement } | null) => ({ surface, from, to }),
  );
  // A tab window closed by the app quitting isn't closed by the user: it opens again, with its tabs, at the next start.
  let quitting = false;
  app.on('before-quit', () => (quitting = true));
  ipcMain.handle(SHELL_IPC.forgetWindow, (_event, owner: WindowOwner, layout: WindowLayout) =>
    quitting ? false : daemon.call('shell.forgetWindow', { owner, layout }),
  );
  passthrough(daemon, SHELL_IPC.tabWindows, 'shell.tabWindows');
  passthrough(daemon, SHELL_IPC.split, 'shell.split', (shellId: string, sessionId: string, direction: SplitDirection, cwd?: string) => ({
    shellId,
    sessionId,
    direction,
    ...(typeof cwd === 'string' ? { cwd } : {}),
  }));
  passthrough(daemon, SHELL_IPC.resizeSplit, 'shell.resizeSplit', (shellId: string, splitId: string, ratio: number) => ({ shellId, splitId, ratio }));
  passthrough(daemon, SHELL_IPC.closeOwnPanes, 'shell.closeOwnPanes', (shellId: string) => ({ shellId }));
  passthrough(daemon, SHELL_IPC.closePane, 'shell.closePane', (shellId: string, sessionId: string) => ({ shellId, sessionId }));
  passthrough(daemon, SHELL_IPC.resumePane, 'shell.resumePane', (shellId: string, sessionId: string) => ({ shellId, sessionId }));
  passthrough(daemon, SHELL_IPC.setName, 'shell.setName', (shellId: string, name: string) => ({ shellId, name }));
  passthrough(daemon, SHELL_IPC.setPaneName, 'shell.setPaneName', (shellId: string, sessionId: string, name: string | null) => ({ shellId, sessionId, name }));
  passthroughVoid(daemon, SHELL_IPC.delete, 'shell.delete', (shellId: string) => ({ shellId }));
}
