import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { sendToAllWindows } from './broadcast';

/** A setting main keeps in a file of its own: its value now, which a new window opens in. */
export interface FileSetting<T> {
  current(): T;
  /** Picks a value from main itself (a menu item), as a window's pick does. */
  set(value: T): void;
  /** Calls `listener` with each pick, after every window was sent it; a listener that throws is logged. Returns the unsubscribe function. */
  onChanged(listener: (value: T) => void): () => void;
}

interface FileSettingSpec<T> {
  dataDir: string;
  /** The setting's name: kept in `<name>.json` as `{ <name>: value }`, and in the error for a value it can't take. */
  name: string;
  channels: { get: string; set: string; changed: string };
  /** What it is when nothing (readable) was saved. */
  fallback: T;
  /** The value as saved, read back untyped. */
  from(saved: unknown): T;
  /** Whether a pick is a value it takes. */
  is(value: unknown): value is T;
  /** Puts the value to work beyond the windows: called with it as it is registered and with each pick. */
  apply?(value: T): void;
}

/**
 * A setting kept in a file of its own in the app's data folder, not the daemon's view state, so it is read before the
 * first window opens and no window paints it wrong. A pick is saved first, then sent to every window.
 */
export function registerFileSetting<T>({ dataDir, name, channels, fallback, from, is, apply }: FileSettingSpec<T>): FileSetting<T> {
  const file = join(dataDir, `${name}.json`);
  let value = load(file, name, from) ?? fallback;
  apply?.(value);

  const listeners = new Set<(value: T) => void>();

  const set = (picked: unknown) => {
    if (!is(picked)) throw new Error(`no such ${name}: ${JSON.stringify(picked)}`);
    // Saved first, whole or not at all: a pick that can't be kept changes nothing.
    const staged = `${file}.${process.pid}.tmp`;
    writeFileSync(staged, JSON.stringify({ [name]: picked }));
    renameSync(staged, file);
    value = picked;
    apply?.(value);
    sendToAllWindows(channels.changed, value);
    // The pick is kept by now: a listener that fails (a menu that can't be built) is logged, not reported as a failed pick.
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error(`agent-board: a listener of the ${name} setting failed:`, error);
      }
    }
  };
  ipcMain.handle(channels.get, () => value);
  ipcMain.handle(channels.set, (_event, picked: unknown) => set(picked));
  return {
    current: () => value,
    set,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What was saved, or undefined if nothing (readable) was. */
function load<T>(file: string, name: string, from: (saved: unknown) => T): T | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof saved === 'object' && saved !== null && name in saved ? from((saved as Record<string, unknown>)[name]) : undefined;
  } catch {
    return undefined;
  }
}
