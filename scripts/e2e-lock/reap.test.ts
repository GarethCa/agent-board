import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePs } from '../../packages/fake-harness/src/processes.ts';
import { electronLeftovers, reapWorktree } from './reap.ts';

const exe = (root: string) => `${root}/node_modules/.pnpm/electron@1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
const listing = [
  `  100     1 ${exe('/wt/a')} /wt/a/apps/desktop/out/main/index.js`,
  `  101   100 ${exe('/wt/a').replace('MacOS/Electron', 'Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper')} --type=renderer`,
  `  102     1 ${exe('/wt/a')} /wt/a/out/main/daemon.js --data-dir /tmp/ab-e2e-x`,
  `  200     1 ${exe('/wt/b')} /wt/b/apps/desktop/out/main/index.js`,
  `  201     1 ${exe('/wt/a-2')} out/main/index.js`,
  `  300     1 /Applications/Agent Board.app/Contents/MacOS/Agent Board`,
  `  301     1 /Applications/Electron.app/Contents/MacOS/Electron`,
  `  400    50 ${exe('/wt/a')} /wt/a/apps/desktop/out/main/index.js`,
  `  401    50 node /wt/a/node_modules/.bin/playwright test`,
].join('\n');

describe('electronLeftovers', () => {
  const pids = (found: { pid: number }[]) => found.map((p) => p.pid);

  it('finds only orphaned Electron processes from this worktree', () => {
    expect(pids(electronLeftovers(parsePs(listing), '/wt/a'))).toEqual([100, 101, 102]);
  });

  it('never matches another worktree, a sibling with the same prefix, or the installed app', () => {
    const found = pids(electronLeftovers(parsePs(listing), '/wt/a'));
    for (const other of [200, 201, 300, 301]) expect(found).not.toContain(other);
  });

  it('also finds live descendants of the run that just ended', () => {
    expect(pids(electronLeftovers(parsePs(listing), '/wt/a', 50))).toEqual([100, 101, 102, 400]);
  });
});

describe('reapWorktree', () => {
  it('kills a live process run from the worktree\'s Electron path, and not one run from another', async () => {
    const make = (name: string) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `ab-reap-${name}-`)));
      const dist = join(root, 'node_modules', 'electron', 'dist');
      mkdirSync(dist, { recursive: true });
      symlinkSync(process.execPath, join(dist, 'Electron'));
      return { root, exe: join(dist, 'Electron') };
    };
    const mine = make('mine');
    const other = make('other');
    const start = (exe: string) => {
      const child = spawn(exe, ['-e', "console.log('up');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
      return new Promise<ReturnType<typeof spawn>>((resolve) => child.stdout!.once('data', () => resolve(child)));
    };
    const a = await start(mine.exe);
    const b = await start(other.exe);
    try {
      const reaped = await reapWorktree(mine.root, process.pid);
      expect(reaped).toEqual([a.pid]);
      await new Promise((r) => (a.exitCode !== null || a.signalCode !== null ? r(0) : a.on('close', r)));
      expect(b.exitCode).toBeNull();
      expect(b.signalCode).toBeNull();
    } finally {
      b.kill('SIGKILL');
      a.kill('SIGKILL');
      rmSync(mine.root, { recursive: true, force: true });
      rmSync(other.root, { recursive: true, force: true });
    }
  });
});
