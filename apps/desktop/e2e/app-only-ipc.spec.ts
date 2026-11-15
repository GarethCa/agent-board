import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { connectedDaemonPid, launchApp, removeDataDir, tempDataDir, test } from './launch.ts';

/** The preload every app window runs, as the build put it beside main. */
const preload = fileURLToPath(new URL('../out/preload/index.cjs', import.meta.url));

test("main's IPC answers the board's page, and refuses a page that has the app's preload but isn't one of its windows, on channels given new handlers late", async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    await connectedDaemonPid(await app.firstWindow());
    const calls = await app.evaluate(async ({ BrowserWindow, WebContentsView, ipcMain }, preload) => {
      const board = BrowserWindow.getAllWindows()[0]!;
      // A page main never made one of its windows, given the app's preload anyway: drawn offscreen, never shown.
      const stray = new WebContentsView({ webPreferences: { preload, sandbox: true, contextIsolation: true, offscreen: true } });
      await stray.webContents.loadURL('data:text/html,<title>stray</title>');

      // Two channels the preload calls, one invoked and one sent, given new handlers now, as a channel added later would be.
      const ran: string[] = [];
      ipcMain.removeHandler('zone:list');
      ipcMain.handle('zone:list', () => {
        ran.push('invoked');
        return 'answered';
      });
      ipcMain.removeAllListeners('session:write');
      ipcMain.on('session:write', (_event, sessionId: string) => ran.push(`sent by ${sessionId}`));

      // Real calls through the preload and Electron's own dispatch: the send goes first, so it has arrived by the answer.
      const call = (contents: Electron.WebContents, who: string): Promise<{ api: string; answer: string }> =>
        contents.executeJavaScript(`(async () => {
          const api = typeof window.agentBoard;
          window.agentBoard.sessions.write(${JSON.stringify(who)}, '');
          const answer = await window.agentBoard.zones.list().catch((error) => 'refused: ' + error.message);
          return { api, answer };
        })()`);
      const fromStray = await call(stray.webContents, 'stray');
      const fromBoard = await call(board.webContents, 'board');
      stray.webContents.close();
      return { fromStray, fromBoard, ran };
    }, preload);

    expect(calls.fromStray.api).toBe('object');
    expect(calls.fromStray.answer).toContain("zone:list answers only the app's own windows");
    expect(calls.fromBoard).toEqual({ api: 'object', answer: 'answered' });
    expect(calls.ran).toEqual(['sent by board', 'invoked']);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
