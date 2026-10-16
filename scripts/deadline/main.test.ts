import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { alive } from '../../packages/fake-harness/src/processes.ts';

const main = join(import.meta.dirname, 'main.ts');
const started: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of started.splice(0)) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone already */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(argv: string[]) {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, exited, output: () => output };
}

/** A command that starts a background `sleep` (its pid in the file returned) and then sleeps too. */
function sleeper(): { command: string[]; pid: () => Promise<number> } {
  const dir = mkdtempSync(join(tmpdir(), 'ab-deadline-'));
  dirs.push(dir);
  const file = join(dir, 'pid');
  return {
    command: ['sh', '-c', `sleep 30 & echo $! > ${file}; sleep 30`],
    pid: async () => {
      await until(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '', 5_000);
      return Number(readFileSync(file, 'utf8'));
    },
  };
}

async function until(done: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`not within ${withinMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('deadline', () => {
  it("passes the command's output and exit status through", async () => {
    const { exited, output } = run([process.execPath, main, 'lint', '10', '--', 'sh', '-c', 'echo linted; exit 3']);
    expect(await exited).toBe(3);
    expect(output()).toContain('linted');
  });

  it('stops a stage that runs past its limit, with everything it started, and says so', async () => {
    const work = sleeper();
    const begun = Date.now();
    const { exited, output } = run([process.execPath, main, 'test', '0.02', '--', ...work.command]);
    const background = await work.pid();
    expect(await exited).toBe(124);
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(output()).toContain('stage `test` exceeded its 0.02 min limit');
    await until(() => !alive(background), 3_000);
  });

  it('stops the stage, with everything it started, when the gate that started it is killed', async () => {
    const work = sleeper();
    const gate = run(['sh', '-c', '"$@" & wait', 'sh', process.execPath, main, 'test', '10', '--', ...work.command]);
    const background = await work.pid();
    process.kill(gate.child.pid!, 'SIGKILL');
    await until(() => !alive(background), 5_000);
  });

  it('refuses a limit that is not a number of minutes', async () => {
    const { exited, output } = run([process.execPath, main, 'test', 'soon', '--', 'true']);
    expect(await exited).toBe(2);
    expect(output()).toContain('usage');
  });
});
