/**
 * The merge gate (scripts/check-local.sh) on a fake `pnpm` whose steps all pass, and whose e2e run reports a test that
 * passed only on a retry. git reads a throwaway repo (GIT_DIR), so the tree's being clean or not is up to the test.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readStamp } from './stamp.ts';

const gate = join(import.meta.dirname, '..', 'check-local.sh');
let dir: string | undefined;
let group: number | undefined;

afterEach(() => {
  if (group !== undefined) try { process.kill(-group, 'SIGKILL'); } catch { /* gone already */ }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  group = dir = undefined;
});

const FLAKY_REPORT = {
  suites: [{ title: 'board.spec.ts', specs: [{ title: 'drags a tile', file: 'board.spec.ts', line: 12, tests: [{ projectName: 'app', status: 'flaky' }] }] }],
};

interface GateOptions {
  /** Leaves an untracked file in the gate's repo. */
  dirty?: boolean;
  /** The one `pnpm` script that fails, e.g. `lint`. */
  failing?: string;
  /** Leaves a flaky e2e report in the log dir, as an earlier run would, and has this run's e2e write none. */
  staleReport?: boolean;
}

/** Runs the gate with every step passing but `failing`. */
async function runGate(args: string[], { dirty = false, failing, staleReport = false }: GateOptions = {}): Promise<{ code: number | null; output: string; sha: string; stamps: string }> {
  dir = mkdtempSync(join(tmpdir(), 'ab-gate-'));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  const calls = join(dir, 'calls');
  mkdirSync(bin);
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'x');
  if (dirty) writeFileSync(join(repo, 'new.txt'), 'x\n');
  writeFileSync(join(dir, 'e2e.json'), JSON.stringify(FLAKY_REPORT));
  const logs = join(dir, 'logs');
  mkdirSync(logs);
  if (staleReport) writeFileSync(join(logs, 'e2e.json'), JSON.stringify(FLAKY_REPORT));
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${calls}`,
      // The e2e run (`pnpm test:e2e …`) reports a flaky test; the visual run (`pnpm --filter …`) none.
      staleReport ? '' : `case "$1" in test:e2e) cp ${join(dir, 'e2e.json')} "$PLAYWRIGHT_JSON_OUTPUT_FILE" ;; --filter) echo '{"suites":[]}' > "$PLAYWRIGHT_JSON_OUTPUT_FILE" ;; esac`,
      failing === undefined ? '' : `[ "$1" = ${failing} ] && exit 1`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  const stamps = join(dir, 'stamps');
  const child = spawn('sh', [gate, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: join(repo, '.git'),
      GIT_WORK_TREE: repo,
      CHECK_LOG_DIR: logs,
      CHECK_STAMP_DIR: stamps,
      AGENT_BOARD_E2E_LOCK: join(dir, 'e2e.lock'),
    },
  });
  group = child.pid;
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, output: `${output}\n${readFileSync(calls, 'utf8')}`, sha: git('rev-parse', 'HEAD'), stamps };
}

it('passes a run whose e2e test passed only on a retry, names the test as flaky, and stamps the commit green', async () => {
  const { code, output, sha, stamps } = await runGate([]);

  expect(code).toBe(0);
  expect(output).toMatch(/\| `e2e` \| pass, 1 flaky \| \d+s \|/);
  expect(output).toMatch(/\| `visual` \| pass \| \d+s \|/);
  expect(output).toContain('- [app] board.spec.ts:12 › drags a tile');
  // The Electron runs get their retries and a JSON report.
  expect(output).toContain('test:e2e --retries 2 --reporter list,json --update-snapshots none');
  expect(output).toMatch(/--filter @agent-board\/desktop test:visual .*--retries 2 --reporter list,json --update-snapshots none/);
  expect(readStamp(stamps, sha)).toBeInstanceOf(Date);
});

it('writes no stamp from a tree with uncommitted changes', async () => {
  const { code, stamps } = await runGate([], { dirty: true });

  expect(code).toBe(0);
  expect(() => readdirSync(stamps)).toThrow();
});

it('writes no stamp from a run with a failed step', async () => {
  const { code, output, stamps } = await runGate([], { failing: 'lint' });

  expect(code).toBe(1);
  expect(output).toMatch(/\| `lint` \| FAIL \|/);
  expect(() => readdirSync(stamps)).toThrow();
});

it("reads no flaky tests from an earlier run's report left in a reused log dir", async () => {
  const { code, output } = await runGate([], { staleReport: true });

  expect(code).toBe(0);
  expect(output).toMatch(/\| `e2e` \| pass \| \d+s \|/);
  expect(output).not.toContain('Flaky');
});

it('--quick runs all but the visual and e2e steps, and writes no stamp', async () => {
  const { code, output, stamps } = await runGate(['--quick']);

  expect(code).toBe(0);
  expect(output).toContain('Quick Local checks');
  for (const step of ['lint', 'typecheck', 'test', 'build', 'markdownlint', 'knip']) expect(output).toMatch(new RegExp(`\\| \`${step}\` \\| pass \\|`));
  for (const step of ['e2e', 'visual']) expect(output).not.toContain(`| \`${step}\` |`);
  expect(output).not.toContain('test:e2e');
  expect(() => readdirSync(stamps)).toThrow();
});
