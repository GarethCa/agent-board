import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppPage, isAppWindow, markAppWindow } from './app-windows';

/** A web contents as the registry sees it. */
function contents(destroyed = false) {
  return { isDestroyed: () => destroyed } as unknown as Electron.WebContents;
}

describe('app windows', () => {
  it('knows the web contents marked as the app’s own windows, and no others', () => {
    const board = contents();
    const webTab = contents();
    markAppWindow(board, () => true);

    expect(isAppWindow(board)).toBe(true);
    expect(isAppWindow(webTab)).toBe(false);
  });

  it("counts an app window's page as the app's only while it shows the app's own page", () => {
    const board = contents();
    const webTab = contents();
    markAppWindow(board, (url) => url === 'file:///app/index.html');

    expect(isAppPage(board, 'file:///app/index.html')).toBe(true);
    expect(isAppPage(board, 'https://example.com/')).toBe(false);
    expect(isAppPage(webTab, 'file:///app/index.html')).toBe(false);
  });

  it('drops a window once its web contents is destroyed', () => {
    const closed = contents(true);
    markAppWindow(closed, () => true);

    expect(isAppWindow(closed)).toBe(false);
    expect(isAppPage(closed, 'file:///app/index.html')).toBe(false);
  });
});

describe("main's entry", () => {
  it('guards ipcMain first, before any import can register a handler', () => {
    const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    const firstImport = source.split('\n').find((line) => line.startsWith('import '));

    expect(firstImport).toBe("import './app-only-ipc';");
  });

  it('marks every renderer window it opens as an app window', () => {
    const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    const opening = source.slice(source.indexOf('const window = new BrowserWindow({'), source.indexOf('guardWindow(window'));

    expect(opening).toContain('markAppWindow(window.webContents, isAppUrl)');
  });
});
