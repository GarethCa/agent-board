import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient, DaemonLink } from '@agent-board/daemon/client';
import { SESSION_IPC } from '../preload/api';
import { revealFolder } from './reveal-folder';
import { registerSessionIpc } from './sessions';

const shell = vi.hoisted(() => ({ showItemInFolder: vi.fn(), openPath: vi.fn() }));
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  shell,
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}));

describe('revealFolder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reveals an app bundle in the file manager and never opens it', () => {
    const bundle = join(mkdtempSync(join(tmpdir(), 'reveal-')), 'Thing.app');
    mkdirSync(bundle);
    revealFolder(bundle);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(bundle);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('refuses a relative path, a file and a missing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reveal-'));
    const file = join(dir, 'file.txt');
    writeFileSync(file, '');
    expect(() => revealFolder('relative/dir')).toThrow('not a folder');
    expect(() => revealFolder(file)).toThrow('not a folder');
    expect(() => revealFolder(join(dir, 'missing'))).toThrow();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('the reveal-folder IPC handler', () => {
  it('reveals an app bundle through the session IPC and never opens it', () => {
    const daemon = { onEvent: () => () => {}, call: vi.fn() } as unknown as DaemonLink;
    registerSessionIpc(daemon, () => Promise.resolve({} as DaemonClient));
    const bundle = join(mkdtempSync(join(tmpdir(), 'reveal-')), 'Thing.app');
    mkdirSync(bundle);
    handlers.get(SESSION_IPC.revealFolder)?.({}, bundle);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(bundle);
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
