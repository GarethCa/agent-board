import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_IPC } from '../preload/api';
import { registerAppearance } from './appearance';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  nativeTheme: { themeSource: 'system' as string },
  sent: [] as unknown[][],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  nativeTheme: electron.nativeTheme,
}));
vi.mock('./broadcast', () => ({ sendToAllWindows: (...args: unknown[]) => electron.sent.push(args) }));

describe('the Appearance setting', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'appearance-'));
    electron.handlers.clear();
    electron.nativeTheme.themeSource = 'system';
    electron.sent.length = 0;
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({}, ...args);

  it('follows the system until something is picked', async () => {
    const setting = registerAppearance(dir);
    expect(electron.nativeTheme.themeSource).toBe('system');
    expect(await call(APPEARANCE_IPC.get)).toBe('system');
    expect(setting.current()).toBe('system');
  });

  it('starts on a default other than System when given one, as tests pin the theme', async () => {
    registerAppearance(dir, 'light');
    expect(electron.nativeTheme.themeSource).toBe('light');
    expect(await call(APPEARANCE_IPC.get)).toBe('light');
  });

  it('keeps a pick for the next launch, then points every window at it and tells them', async () => {
    const setting = registerAppearance(dir);
    await call(APPEARANCE_IPC.set, 'dark');
    expect(electron.nativeTheme.themeSource).toBe('dark');
    expect(setting.current()).toBe('dark');
    expect(electron.sent).toEqual([[APPEARANCE_IPC.changed, 'dark']]);
    expect(JSON.parse(readFileSync(join(dir, 'appearance.json'), 'utf8'))).toEqual({ appearance: 'dark' });
    expect(readdirSync(dir)).toEqual(['appearance.json']);

    electron.nativeTheme.themeSource = 'system';
    registerAppearance(dir, 'light');
    expect(electron.nativeTheme.themeSource).toBe('dark');
    expect(await call(APPEARANCE_IPC.get)).toBe('dark');
  });

  it('changes nothing when the pick cannot be kept', async () => {
    registerAppearance(dir);
    chmodSync(dir, 0o500);
    expect(() => call(APPEARANCE_IPC.set, 'dark')).toThrow();
    expect(electron.nativeTheme.themeSource).toBe('system');
    expect(await call(APPEARANCE_IPC.get)).toBe('system');
    expect(electron.sent).toEqual([]);
  });

  it('takes nothing but System or a theme in the registry', () => {
    registerAppearance(dir);
    expect(() => call(APPEARANCE_IPC.set, 'sepia')).toThrow(/sepia/);
    expect(electron.nativeTheme.themeSource).toBe('system');
  });

  it('shrugs off a damaged file, following the system', () => {
    writeFileSync(join(dir, 'appearance.json'), '{not json');
    registerAppearance(dir);
    expect(electron.nativeTheme.themeSource).toBe('system');
  });
});
