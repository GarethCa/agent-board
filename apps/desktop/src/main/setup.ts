import { ipcMain, Menu, Notification, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonLink } from '@agent-board/daemon/client';
import { installCli } from '@agent-board/daemon/cli-install';
import type { SetupTool } from '@agent-board/daemon/protocol';
import { SETUP_IPC } from '../preload/api';
import { revealWindow } from './background';
import type { Notifier } from './notifications';

/**
 * Onboarding's and Settings' IPC: the daemon's CLI checks, the notification that asks the OS for permission, and
 * installing the `agent-board` command line.
 */
export function registerSetupIpc(daemon: DaemonLink, notify: Notifier): void {
  ipcMain.handle(SETUP_IPC.check, (_event, tool: SetupTool) => daemon.call('setup.check', { tool }));
  ipcMain.handle(SETUP_IPC.testNotification, () => {
    // Tests' fake notifier stands in for the OS, so it is always "supported".
    if (!process.env.AGENT_BOARD_FAKE_NOTIFICATIONS && !Notification.isSupported()) return { shown: false };
    notify({ title: 'Test notification', body: 'agent-board will tell you like this when an agent needs you.' }, () => {});
    return { shown: true };
  });
  ipcMain.handle(SETUP_IPC.installCli, async () => {
    const { cliPath } = await daemon.call('daemon.health');
    if (cliPath === null) throw new Error('the daemon has no agent-board command line to link');
    return installCli(cliPath, join(homedir(), '.local', 'bin'));
  });
}

/**
 * The app menu: Electron's default one, with Help › Getting started, which reopens onboarding on the board (`window`,
 * opening it if need be). A request made while the board loads is kept until it asks (`takeGettingStarted`), as
 * opening an agent is.
 */
export function setAppMenu(window: () => BrowserWindow): void {
  let requested = false;
  ipcMain.handle(SETUP_IPC.takeGettingStarted, () => {
    const taken = requested;
    requested = false;
    return taken;
  });
  const gettingStarted = () => {
    requested = true;
    const target = window();
    revealWindow(target);
    target.webContents.send(SETUP_IPC.gettingStarted);
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    // No zoom items: ⌘+ ⌘- ⌘0 size the terminal text, and the board has its own zoom.
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Getting started', click: gettingStarted }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
