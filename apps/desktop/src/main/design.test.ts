import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_IPC } from '../preload/api';
import { registerDesign } from './design';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sent: [] as unknown[][],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
}));
vi.mock('./broadcast', () => ({ sendToAllWindows: (...args: unknown[]) => electron.sent.push(args) }));

describe('the Simplified design setting', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'design-'));
    electron.handlers.clear();
    electron.sent.length = 0;
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({}, ...args);

  it('is Classic until Simplified is picked', async () => {
    const setting = registerDesign(dir);
    expect(await call(DESIGN_IPC.get)).toBe('classic');
    expect(setting.current()).toBe('classic');
  });

  it('keeps a pick for the next launch, and tells every window', async () => {
    const setting = registerDesign(dir);
    await call(DESIGN_IPC.set, 'simplified');
    expect(setting.current()).toBe('simplified');
    expect(electron.sent).toEqual([[DESIGN_IPC.changed, 'simplified']]);
    expect(JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'))).toEqual({ design: 'simplified' });
    expect(readdirSync(dir)).toEqual(['design.json']);

    registerDesign(dir);
    expect(await call(DESIGN_IPC.get)).toBe('simplified');
  });

  it('changes nothing when the pick cannot be kept', async () => {
    registerDesign(dir);
    chmodSync(dir, 0o500);
    expect(() => call(DESIGN_IPC.set, 'simplified')).toThrow();
    expect(await call(DESIGN_IPC.get)).toBe('classic');
    expect(electron.sent).toEqual([]);
  });

  it('takes nothing but a design', () => {
    registerDesign(dir);
    expect(() => call(DESIGN_IPC.set, 'pro')).toThrow(/pro/);
    expect(() => call(DESIGN_IPC.set, true)).toThrow(/true/);
    expect(electron.sent).toEqual([]);
  });

  it('opens in Classic over a damaged file or one naming no design', async () => {
    writeFileSync(join(dir, 'design.json'), '{not json');
    registerDesign(dir);
    expect(await call(DESIGN_IPC.get)).toBe('classic');

    writeFileSync(join(dir, 'design.json'), JSON.stringify({ design: 'pro' }));
    registerDesign(dir);
    expect(await call(DESIGN_IPC.get)).toBe('classic');
  });
});
