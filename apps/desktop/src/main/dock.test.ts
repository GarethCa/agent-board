import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCK_IPC } from '../preload/api';
import { dockFrom } from '../shared/dock';
import { registerDock } from './dock';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sent: [] as unknown[][],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
}));
vi.mock('./broadcast', () => ({ sendToAllWindows: (...args: unknown[]) => electron.sent.push(args) }));

describe('the Dock setting', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dock-'));
    electron.handlers.clear();
    electron.sent.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({}, ...args);

  it('shows everything until another is picked', async () => {
    expect(registerDock(dir).current()).toBe('all');
    expect(await call(DOCK_IPC.get)).toBe('all');
  });

  it('keeps a pick for the next launch and tells every window', async () => {
    registerDock(dir);
    await call(DOCK_IPC.set, 'pinned');
    expect(electron.sent).toEqual([[DOCK_IPC.changed, 'pinned']]);
    expect(JSON.parse(readFileSync(join(dir, 'dock.json'), 'utf8'))).toEqual({ dock: 'pinned' });
    expect(registerDock(dir).current()).toBe('pinned');
  });

  it('refuses a mode it does not have, and reads a damaged file as Show everything', () => {
    registerDock(dir);
    expect(() => call(DOCK_IPC.set, 'sideways')).toThrow(/no such dock/);
    writeFileSync(join(dir, 'dock.json'), '{"dock":"sideways"}');
    expect(registerDock(dir).current()).toBe('all');
    expect(dockFrom(null)).toBe('all');
  });
});
