import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@agent-board/tracker';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConditionChecker, createShellRunner, OUTPUT_TAIL, type ConditionSources } from '../src/flow-conditions.ts';
import { tempDataDir } from './helpers.ts';

const AGENT = { sessionId: 's-a', worktree: '/work/a' };
const AT = '2026-10-11T14:01:00.000Z';
/** The fake plan's fingerprint of a command. */
const fp = (command: string) => `fp:${command}`;
/** Every command these tests run, approved. */
const OK = Object.fromEntries(['./ready.sh', 'sleep 999', 'pnpm check:local', 'true'].map((command) => [command, fp(command)]));

const pr = (checks: PullRequest['checks'], fields: Partial<PullRequest> = {}): PullRequest => ({
  number: 214,
  title: 'Movable sessions',
  url: 'https://github.com/acme/app/pull/214',
  state: 'open',
  checks,
  ...fields,
});

/** A checker on fake sources; `runs` records every command it ran, and where. */
function checker(sources: Partial<ConditionSources> = {}) {
  const runs: { command: string; cwd: string }[] = [];
  const check = createConditionChecker({
    pullRequests: () => [],
    issueLabels: async () => [],
    plan: async (command) => ({ command, shown: command, fingerprint: fp(command) }),
    run: async (command, cwd) => {
      runs.push({ command, cwd });
      return { code: 0, timedOut: false, output: '' };
    },
    headCommit: async () => 'abc123',
    now: () => new Date(AT),
    ...sources,
  });
  return { check, runs };
}

describe('the PR checks condition', () => {
  it("passes when the agent's newest pull request's checks pass, and says what it saw otherwise", async () => {
    const seen = (prs: PullRequest[]) => checker({ pullRequests: () => prs }).check.one({ kind: 'pr-checks' }, AGENT, OK);
    expect(await seen([pr('passing'), pr('failing', { number: 200 })])).toEqual({ passed: true, at: AT, detail: 'PR #214 checks passing' });
    expect(await seen([pr('pending')])).toEqual({ passed: false, at: AT, detail: 'PR #214 checks pending' });
    expect(await seen([pr('failing')])).toEqual({ passed: false, at: AT, detail: 'PR #214 checks failing' });
    expect(await seen([pr('none')])).toEqual({ passed: false, at: AT, detail: 'PR #214 has no checks yet' });
    expect(await seen([])).toEqual({ passed: false, at: AT, detail: 'no pull request yet' });
  });
});

describe('the issue label condition', () => {
  it("passes when the agent's linked issue has the label, whatever its case", async () => {
    const { check } = checker({ issueLabels: async () => ['Ready-for-agent', 'bug'] });
    expect(await check.one({ kind: 'issue-label', label: 'ready-for-agent' }, AGENT, OK)).toEqual({
      passed: true,
      at: AT,
      detail: 'has ready-for-agent',
    });
    expect(await check.one({ kind: 'issue-label', label: 'needs-maintainer' }, AGENT, OK)).toEqual({
      passed: false,
      at: AT,
      detail: 'no needs-maintainer label',
    });
  });

  it("fails, saying why, when the labels can't be read", async () => {
    const { check } = checker({ issueLabels: async () => 'it has no linked issue' });
    expect(await check.one({ kind: 'issue-label', label: 'x' }, AGENT, OK)).toEqual({ passed: false, at: AT, detail: 'it has no linked issue' });
    const failing = checker({ issueLabels: async () => Promise.reject(new Error('Linear is down')) });
    expect(await failing.check.one({ kind: 'issue-label', label: 'x' }, AGENT, OK)).toEqual({
      passed: false,
      at: AT,
      detail: 'could not read the labels: Linear is down',
    });
  });
});

describe('the custom script condition', () => {
  it("runs the command in the agent's worktree every time, passing when it exits 0", async () => {
    let code = 1;
    const { check, runs } = checker({
      run: async (command, cwd) => {
        runs.push({ command, cwd });
        return { code, timedOut: false, output: 'not yet\nwaiting on review\n' };
      },
    });
    expect(await check.one({ kind: 'script', command: './ready.sh' }, AGENT, OK)).toEqual({
      passed: false,
      at: AT,
      detail: 'exited 1: waiting on review',
    });
    code = 0;
    expect(await check.one({ kind: 'script', command: './ready.sh' }, AGENT, OK)).toEqual({ passed: true, at: AT, detail: 'exited 0' });
    expect(runs).toEqual([
      { command: './ready.sh', cwd: '/work/a' },
      { command: './ready.sh', cwd: '/work/a' },
    ]);
  });

  it('fails when it times out', async () => {
    const { check } = checker({ run: async () => ({ code: null, timedOut: true, output: '' }) });
    expect(await check.one({ kind: 'script', command: 'sleep 999' }, AGENT, OK)).toMatchObject({ passed: false, detail: 'timed out' });
  });
});

describe('the gate green condition', () => {
  it('runs the gate once per head commit: again only once the agent commits', async () => {
    let head = 'abc123';
    let code = 1;
    const runs: string[] = [];
    const { check } = checker({
      headCommit: async () => head,
      run: async (command) => {
        runs.push(command);
        return { code, timedOut: false, output: 'lint: 2 errors' };
      },
    });
    const gate = { kind: 'gate-green', command: 'pnpm check:local' } as const;

    expect(await check.one(gate, AGENT, OK)).toEqual({ passed: false, at: AT, detail: 'red at abc123: exited 1: lint: 2 errors' });
    code = 0;
    expect(await check.one(gate, AGENT, OK)).toMatchObject({ passed: false });
    head = 'def456';
    expect(await check.one(gate, AGENT, OK)).toEqual({ passed: true, at: AT, detail: 'green at def456' });
    expect(runs).toEqual(['pnpm check:local', 'pnpm check:local']);
  });
});

describe('the gate green condition, asked by several edges', () => {
  it('shares one run between edges asking while it runs, so a suite never runs twice at once in one worktree', async () => {
    let finish: (code: number) => void = () => {};
    let runs = 0;
    const { check } = checker({
      run: () => {
        runs += 1;
        return new Promise((resolve) => (finish = (code) => resolve({ code, timedOut: false, output: '' })));
      },
    });
    const gate = { kind: 'gate-green', command: 'pnpm check:local' } as const;
    const first = check.one(gate, AGENT, OK);
    const second = check.one(gate, AGENT, OK);
    await new Promise((resolve) => setTimeout(resolve, 10));
    finish(0);
    expect((await first).passed).toBe(true);
    expect((await second).passed).toBe(true);
    expect(runs).toBe(1);
  });
});

describe('checking every condition', () => {
  it("doesn't run a gate while a quicker condition fails", async () => {
    const { check, runs } = checker({ pullRequests: () => [pr('pending')] });
    expect(await check.all([{ kind: 'gate-green', command: 'pnpm check:local' }, { kind: 'pr-checks' }], AGENT, OK)).toEqual([
      { passed: false, at: AT, detail: 'not run until the other conditions pass' },
      { passed: false, at: AT, detail: 'PR #214 checks pending' },
    ]);
    expect(runs).toEqual([]);
  });

  it('checks each one, in order', async () => {
    const { check } = checker({ pullRequests: () => [pr('pending')] });
    expect(await check.all([{ kind: 'script', command: 'true' }, { kind: 'pr-checks' }], AGENT, OK)).toEqual([
      { passed: true, at: AT, detail: 'exited 0' },
      { passed: false, at: AT, detail: 'PR #214 checks pending' },
    ]);
  });
});

describe('the shell runner', () => {
  it("runs in the worktree without the daemon's own ELECTRON_RUN_AS_NODE, GIT_DIR or GIT_WORK_TREE", async () => {
    const runner = createShellRunner({ ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere' });
    const dir = tempDataDir();
    const result = await runner.run('pwd; echo "[$ELECTRON_RUN_AS_NODE][$GIT_DIR][$GIT_WORK_TREE]"; exit 3', dir, 5_000);
    expect(result).toEqual({ code: 3, timedOut: false, output: `${dir}\n[][][]\n` });
  });

  it('stops the whole process group when it runs out of time, not just the shell', async () => {
    const dir = tempDataDir();
    const runner = createShellRunner();
    const result = await runner.run('(sleep 1; echo late > late.txt) & sleep 30', dir, 200);
    expect(result).toMatchObject({ code: null, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(() => readFileSync(join(dir, 'late.txt'))).toThrow();
  });

  it('keeps only the end of a lot of output, which is no failure', async () => {
    const runner = createShellRunner();
    const result = await runner.run('yes | head -c 5000000; echo; echo last line', tempDataDir(), 10_000);
    expect(result.code).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(OUTPUT_TAIL);
    expect(result.output.trim().split('\n').at(-1)).toBe('last line');
  });

  it('stops what is still running when told to', async () => {
    const runner = createShellRunner();
    const running = runner.run('sleep 30', tempDataDir(), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.stop();
    expect(await running).toMatchObject({ code: null, timedOut: false });
  });
});

describe('approving what a gate or script runs', () => {
  it("doesn't run a command that isn't approved, or that has changed since it was approved", async () => {
    let version = 1;
    const { check, runs } = checker({ plan: async (command) => ({ command, shown: command, fingerprint: `${fp(command)}@${version}` }) });
    const script = { kind: 'script', command: './ready.sh' } as const;
    const gate = { kind: 'gate-green', command: 'pnpm check:local' } as const;
    expect(await check.one(script, AGENT, {})).toEqual({ passed: false, at: AT, detail: 'waiting for your approval', needsApproval: true });
    expect(await check.one(gate, AGENT, {})).toEqual({ passed: false, at: AT, detail: 'waiting for your approval', needsApproval: true });

    const approved = { './ready.sh': `${fp('./ready.sh')}@1`, 'pnpm check:local': `${fp('pnpm check:local')}@1` };
    expect(await check.one(script, AGENT, approved)).toMatchObject({ passed: true });
    expect(await check.one(gate, AGENT, approved)).toMatchObject({ passed: true });
    expect(runs).toHaveLength(2);

    version = 2;
    const changed = { passed: false, at: AT, detail: 'changed since you approved it: waiting for your approval', needsApproval: true };
    expect(await check.one(script, AGENT, approved)).toEqual(changed);
    expect(await check.one(gate, AGENT, approved)).toEqual(changed);
    expect(runs).toHaveLength(2);
  });

  it('runs a gate again at the same head commit once what it runs changes and is approved again', async () => {
    let version = 1;
    const { check, runs } = checker({ plan: async (command) => ({ command, shown: command, fingerprint: `v${version}` }) });
    const gate = { kind: 'gate-green', command: 'pnpm check:local' } as const;
    await check.one(gate, AGENT, { 'pnpm check:local': 'v1' });
    await check.one(gate, AGENT, { 'pnpm check:local': 'v1' });
    version = 2;
    await check.one(gate, AGENT, { 'pnpm check:local': 'v2' });
    expect(runs).toHaveLength(2);
  });

  it('says a gate waits for approval even while another condition fails', async () => {
    const { check } = checker({ pullRequests: () => [pr('pending')] });
    expect(await check.all([{ kind: 'gate-green', command: 'pnpm check:local' }, { kind: 'pr-checks' }], AGENT, {})).toEqual([
      { passed: false, at: AT, detail: 'waiting for your approval', needsApproval: true },
      { passed: false, at: AT, detail: 'PR #214 checks pending' },
    ]);
  });
});
