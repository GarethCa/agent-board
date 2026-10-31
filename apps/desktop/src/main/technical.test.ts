import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TECHNICAL_IPC } from '../preload/api';
import { registerTechnical } from './technical';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sent: [] as unknown[][],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
}));
vi.mock('./broadcast', () => ({ sendToAllWindows: (...args: unknown[]) => electron.sent.push(args) }));

describe('the Show technical details setting', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'technical-'));
    electron.handlers.clear();
    electron.sent.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({}, ...args);

  it('is off until it is turned on', async () => {
    const setting = registerTechnical(dir);
    expect(await call(TECHNICAL_IPC.get)).toBe(false);
    expect(setting.current()).toBe(false);
  });

  it('keeps a pick for the next launch, and tells every window and main’s own listeners', async () => {
    const setting = registerTechnical(dir);
    const picked = vi.fn();
    setting.onChanged(picked);
    await call(TECHNICAL_IPC.set, true);
    expect(setting.current()).toBe(true);
    expect(picked).toHaveBeenCalledWith(true);
    expect(electron.sent).toEqual([[TECHNICAL_IPC.changed, true]]);
    expect(JSON.parse(readFileSync(join(dir, 'technical.json'), 'utf8'))).toEqual({ technical: true });

    registerTechnical(dir);
    expect(await call(TECHNICAL_IPC.get)).toBe(true);
  });

  it('takes a pick made in main, as the View menu makes it', () => {
    const setting = registerTechnical(dir);
    setting.set(true);
    expect(setting.current()).toBe(true);
    expect(electron.sent).toEqual([[TECHNICAL_IPC.changed, true]]);
  });

  it('reports a kept pick as kept when one of main’s listeners fails', async () => {
    const setting = registerTechnical(dir);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    setting.onChanged(() => {
      throw new Error('menu broke');
    });
    setting.onChanged(after);
    await expect(Promise.resolve(call(TECHNICAL_IPC.set, true))).resolves.toBeUndefined();
    expect(setting.current()).toBe(true);
    expect(after).toHaveBeenCalledWith(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('takes nothing but on or off', () => {
    registerTechnical(dir);
    expect(() => call(TECHNICAL_IPC.set, 'on')).toThrow(/on/);
    expect(() => call(TECHNICAL_IPC.set, 1)).toThrow(/1/);
    expect(electron.sent).toEqual([]);
  });

  it('opens off over a damaged file or one that holds no switch', async () => {
    writeFileSync(join(dir, 'technical.json'), '{not json');
    registerTechnical(dir);
    expect(await call(TECHNICAL_IPC.get)).toBe(false);

    writeFileSync(join(dir, 'technical.json'), JSON.stringify({ technical: 'yes' }));
    registerTechnical(dir);
    expect(await call(TECHNICAL_IPC.get)).toBe(false);
  });
});
