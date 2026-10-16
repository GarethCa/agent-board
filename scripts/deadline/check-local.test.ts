/**
 * The merge gate (scripts/check-local.sh) runs each stage under a wall-clock limit. Here it runs on a fake `pnpm` whose
 * unit tests never finish and whose build fails, so the Electron stages, which would take the machine-wide e2e lock,
 * never start.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { alive } from '../../packages/fake-harness/src/processes.ts';

const gate = join(import.meta.dirname, '..', 'check-local.sh');
let dir: string | undefined;
let group: number | undefined;

afterEach(() => {
  if (group !== undefined) try { process.kill(-group, 'SIGKILL'); } catch { /* gone already */ }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  group = dir = undefined;
});

it('fails a stage that runs past its limit, says so in the table, and leaves nothing of it running', async () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-gate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pidFile = join(dir, 'test.pid');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\ncase "$1" in\n  test) echo $$ > ${pidFile}; exec sleep 60 ;;\n  build) exit 1 ;;\n  knip) exit 124 ;;\n  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  const child = spawn('sh', [gate], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CHECK_LIMIT_MIN: '0.03', CHECK_LOG_DIR: join(dir, 'logs') },
  });
  group = child.pid;
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  expect(code).toBe(1);
  expect(output).toMatch(/\| `test` \| FAIL: over its 0\.03 min limit \| \d+s \|/);
  expect(output).toContain('| `lint` | pass |');
  // A step that exits 124 on its own did not run over.
  expect(output).toMatch(/\| `knip` \| FAIL \| \d+s \|/);
  expect(readFileSync(join(dir, 'logs', 'test.log'), 'utf8')).toContain('stage `test` exceeded its 0.03 min limit');
  expect(existsSync(pidFile)).toBe(true);
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
});
