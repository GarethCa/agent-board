import { app, BrowserWindow, ipcMain, Menu, Notification } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonLink } from '@agent-board/daemon/client';
import { installCli } from '@agent-board/daemon/cli-install';
import type { SetupTool } from '@agent-board/daemon/protocol';
import { MENU_BAR_IPC, MINIMISED_IPC, SETUP_IPC, type MinimisedWindow, type WindowTarget } from '../preload/api';
import { revealWindow } from './background';
import type { Notifier } from './notifications';
import { menuTemplate, RELEASES_URL } from './app-menu';
import type { FileSetting } from './file-setting';
import type { Design } from '../shared/design';
import type { PageKeys } from './page-keys';
import { NO_MENU_BAR_STATE, type MenuBarCommand, type MenuBarState } from '../shared/menu-bar';
import { openWebLink } from './links';

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
 * The app menu bar (`menuTemplate`). Its registry items, the selection's Agent and Project menus and the board's own
 * commands follow the focused window, which reports what it can do (`MENU_BAR_IPC.report`) and runs what is picked in
 * it (`MENU_BAR_IPC.run`); with none focused, the live board's. Help › Getting started which reopens onboarding on the board
 * (`window`, opening it if need be), Window › Overview (`overview`, the Overview window), and on macOS an app menu
 * with About, Settings… (`settings`, the Settings window) and Check for Updates…. A request made while the board loads is kept until it asks (`takeGettingStarted`), as opening
 * an agent is. Under the Simplified design, View › Show Technical Details turns `technical` on or off; the menu bar is
 * built again whenever it or the `design` changes, so the item follows a pick made in any window.
 */
export function setAppMenu(
  window: () => BrowserWindow,
  { settings, overview }: { settings: () => void; overview: () => void },
  { design, technical }: { design: FileSetting<Design>; technical: FileSetting<boolean> },
  { liveBoard, openBoard }: { liveBoard: () => BrowserWindow | undefined; openBoard: (showing: WindowTarget) => BrowserWindow },
  pageKept?: PageKeys,
): void {
  // The board's minimised windows, which the Window menu lists; the board reports them whenever they change.
  let minimised: readonly MinimisedWindow[] = [];
  ipcMain.on(MINIMISED_IPC.report, (_event, windows: unknown) => {
    minimised = Array.isArray(windows)
      ? windows.filter((entry): entry is MinimisedWindow => typeof entry?.id === 'string' && typeof entry?.title === 'string' && (entry.kind === 'session' || entry.kind === 'shell'))
      : [];
    build();
  });
  // What each window last reported, by its web contents; dropped when it goes.
  const states = new Map<number, MenuBarState>();
  const target = () => BrowserWindow.getFocusedWindow() ?? liveBoard();
  ipcMain.on(MENU_BAR_IPC.report, (event, state: MenuBarState) => {
    const id = event.sender.id;
    if (!states.has(id)) event.sender.once('destroyed', () => states.delete(id));
    states.set(id, state);
    if (target()?.webContents.id === id) build();
  });
  app.on('browser-window-focus', () => build());
  const run = (command: MenuBarCommand) => {
    const window = target();
    if (window === undefined || window === null) return;
    // A chord a web page in that window just kept (Ctrl+D off macOS) is the page's, not the board's too.
    if (command.kind === 'key' && command.viaKey && pageKept?.took(window.webContents.id, states.get(window.webContents.id)?.keys[command.id]?.accelerator) === true) return;
    window.webContents.send(MENU_BAR_IPC.run, command);
  };
  const asks = (poke: string, take: string) => {
    let asked = false;
    ipcMain.handle(take, () => {
      const taken = asked;
      asked = false;
      return taken;
    });
    return () => {
      asked = true;
      const target = window();
      revealWindow(target);
      target.webContents.send(poke);
    };
  };
  const actions = {
    about: () => app.showAboutPanel(),
    settings,
    overview,
    checkForUpdates: () => void openWebLink(RELEASES_URL).catch(() => {}),
    gettingStarted: asks(SETUP_IPC.gettingStarted, SETUP_IPC.takeGettingStarted),
  };
  // While a menu is open it is not built again, which would close it under the pointer as a selected zone redraws; a
  // report meanwhile builds it once it closes.
  let open = false;
  let held = false;
  const build = () => {
    if (open) {
      held = true;
      return;
    }
    const template = menuTemplate({ mac: process.platform === 'darwin', packaged: app.isPackaged, name: app.name }, actions, {
      simplified: design.current() === 'simplified',
      on: technical.current(),
      // A pick that can't be saved leaves the setting as it was; the menu is built again to untick it. (A menu that
      // can't be built after a kept pick is the setting's listener's failure, logged there.)
      set: (on) => {
        try {
          technical.set(on);
        } catch (error) {
          console.error('agent-board: could not keep Show technical details:', error);
          build();
        }
      },
    }, minimised.map((entry) => ({
      title: entry.title,
      restore: () => {
        // With no board open it opens showing the window: a message would reach it before it listened.
        const live = liveBoard();
        if (live === undefined) {
          revealWindow(openBoard(entry));
          return;
        }
        revealWindow(live);
        live.webContents.send(MINIMISED_IPC.restore, entry.id);
      },
    })), { state: states.get(target()?.webContents.id ?? -1) ?? NO_MENU_BAR_STATE, run });
    const menu = Menu.buildFromTemplate(template);
    for (const item of menu.items) {
      item.submenu?.on('menu-will-show', () => {
        open = true;
      });
      item.submenu?.on('menu-will-close', () => {
        open = false;
        if (!held) return;
        held = false;
        // After the pick the closing menu runs, which may itself report.
        setImmediate(build);
      });
    }
    Menu.setApplicationMenu(menu);
  };
  build();
  design.onChanged(build);
  technical.onChanged(build);
}
