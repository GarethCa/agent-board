import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain, nativeTheme } from 'electron';
import { sendToAllWindows } from './broadcast';
import { APPEARANCE_IPC } from '../preload/api';
import { APPEARANCES, appearanceFrom, themeSourceFor, type Appearance } from '../shared/appearance';

/** The setting as main holds it: what a new window opens in. */
export interface AppearanceSetting {
  current(): Appearance;
}

/**
 * The Appearance setting: kept in a file of its own in the app's data folder, not the daemon's view state, so
 * it is read before the first window opens and no window flashes the wrong theme. It drives Electron's
 * `nativeTheme.themeSource`, which every window's `prefers-color-scheme` follows, and macOS's own parts of the
 * windows too; a pick is sent to every window, which shows its theme (renderer/src/themes.ts).
 */
export function registerAppearance(dataDir: string, fallback: Appearance = 'system'): AppearanceSetting {
  const file = join(dataDir, 'appearance.json');
  let appearance = load(file) ?? fallback;
  nativeTheme.themeSource = themeSourceFor(appearance);

  ipcMain.handle(APPEARANCE_IPC.get, () => appearance);
  ipcMain.handle(APPEARANCE_IPC.set, (_event, picked: unknown) => {
    if (!APPEARANCES.includes(picked as Appearance)) throw new Error(`no such appearance: ${String(picked)}`);
    // Saved first, whole or not at all: a pick that can't be kept changes nothing.
    const staged = `${file}.${process.pid}.tmp`;
    writeFileSync(staged, JSON.stringify({ appearance: picked }));
    renameSync(staged, file);
    appearance = picked as Appearance;
    nativeTheme.themeSource = themeSourceFor(appearance);
    sendToAllWindows(APPEARANCE_IPC.changed, appearance);
  });
  return { current: () => appearance };
}

/** What was saved, or undefined if nothing (readable) was. */
function load(file: string): Appearance | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof saved === 'object' && saved !== null && 'appearance' in saved ? appearanceFrom(saved.appearance) : undefined;
  } catch {
    return undefined;
  }
}
