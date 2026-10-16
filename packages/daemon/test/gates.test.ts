import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { isProcessAlive } from '../src/pid.ts';
import { DatabaseSync } from 'node:sqlite';
import { createGateHost } from '../src/gates.ts';
import { migrate } from '../src/migrate.ts';
import { BOARD_CALLER_METHODS, BOARD_ERROR, RPC_ERROR, type Agent, type DaemonMethod, type GateRun, type GateUpdatedEvent } from '../src/protocol.ts';
import { paneIds } from '../src/pane-layout.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** The fake gate command (fixtures/gate), quoted as a zone's gate command holds it. */
const FAKE_GATE = fileURLToPath(new URL('../../../fixtures/gate/fake-gate.sh', import.meta.url));
const gateCommand = (mode: string) => `sh '${FAKE_GATE}' ${mode}`;

/** A daemon with one agent, in a zone whose gate command runs the fake gate in `mode`. */
async function gateDaemon(mode = 'pass') {
  const tmp = tempDataDir();
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: { ...fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }), TMPDIR: tmp } });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  await client.call('zone.configure', { id: zone.id, gateCommand: gateCommand(mode) });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Fix checkout', name: 'Fix checkout flake', ...SIZE });
  const ended = (sessionId: string) =>
    recorder
      .waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.sessionId === sessionId && e.run.status !== 'running')
      .then((e) => e.run);
  return { daemon, dataDir, client, recorder, repo, zone, agent, ended, tmp };
}

const names = (run: GateRun) => run.steps.map((step) => `${step.name} ${step.status}`);

describe('the merge gate', () => {
  it("runs the zone's gate command in the agent's worktree, its steps as it marks them, on the commit it was at", async () => {
    const { client, agent, ended } = await gateDaemon('pass');

    const started = await client.call('gate.run', { sessionId: agent.sessionId });

    expect(started).toMatchObject({ sessionId: agent.sessionId, command: gateCommand('pass'), status: 'running', commit: git(agent.worktree, 'rev-parse', 'HEAD'), dirty: false });
    const run = await ended(agent.sessionId);
    expect(run).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(names(run)).toEqual(['lint passed', 'test passed', 'e2e passed']);
    expect(await client.call('gate.list')).toEqual([run]);
  });

  it('keeps each step its own log: its lines, or the file it named, and the whole output besides', async () => {
    const { client, agent, ended } = await gateDaemon('pass');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await ended(agent.sessionId);

    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: 'lint' })).text).toBe('lint: 12 files, no problems\n');
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: 'test' })).text).toBe('✓ src/case-1.test.ts\n✓ src/case-2.test.ts\n✓ src/case-3.test.ts\n');
    const output = await client.call('gate.log', { sessionId: agent.sessionId });
    expect(output.text).toContain('::gate start lint\nlint: 12 files, no problems\n::gate end lint pass\n');
    // Read on from where it got to: nothing new.
    expect(await client.call('gate.log', { sessionId: agent.sessionId, since: output.next })).toMatchObject({ text: '', next: output.next });
  });

  it('fails when a step fails, saying which, with that step\'s last lines', async () => {
    const { client, agent, ended } = await gateDaemon('fail');
    await client.call('gate.run', { sessionId: agent.sessionId });

    const run = await ended(agent.sessionId);

    expect(run).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(names(run)).toEqual(['lint passed', 'test passed', 'e2e failed']);
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: 'e2e' })).text).toContain('Expected "Out of stock" to be visible');
  });

  it('streams a step as it runs, and the run reads as running until it ends', async () => {
    const { client, recorder, agent, ended } = await gateDaemon('slow');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test' && step.status === 'running'));

    let seen = '';
    while (!seen.includes('case-2')) {
      seen = (await client.call('gate.log', { sessionId: agent.sessionId, step: 'test' })).text;
      await sleep(50);
    }
    expect((await client.call('gate.status', { sessionId: agent.sessionId })).run?.status).toBe('running');
    expect((await ended(agent.sessionId)).status).toBe('passed');
  });

  it('runs a command that marks no steps as one step, named after it', async () => {
    const { client, agent, ended } = await gateDaemon('plain');
    await client.call('gate.run', { sessionId: agent.sessionId });

    const run = await ended(agent.sessionId);

    expect(names(run)).toEqual([`${gateCommand('plain')} passed`]);
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: gateCommand('plain') })).text).toContain(`pwd: ${agent.cwd}`);
  });

  it('runs the command through sh, so it may chain and expand', async () => {
    const { client, zone, agent, ended } = await gateDaemon('plain');
    const chained = `${gateCommand('plain')} && echo "chained in $PWD"`;
    await client.call('zone.configure', { id: zone.id, gateCommand: chained });
    await client.call('gate.run', { sessionId: agent.sessionId });

    const run = await ended(agent.sessionId);

    expect(run.status).toBe('passed');
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: chained })).text).toContain(`chained in ${agent.cwd}`);
  });

  it('stops the whole process tree on Stop', async () => {
    const { client, recorder, agent, ended, tmp } = await gateDaemon('hang');
    const pidFile = join(tmp, 'child.pid');
    await client.call('zone.configure', { id: agent.zoneId!, gateCommand: `env FAKE_GATE_PID_FILE=${pidFile} ${gateCommand('hang')}` });
    await client.call('gate.run', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test' && step.status === 'running'));
    await expect(client.call('gate.run', { sessionId: agent.sessionId })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('already running') });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(20);
    const child = Number(readFileSync(pidFile, 'utf8'));

    await client.call('gate.stop', { sessionId: agent.sessionId });

    const run = await ended(agent.sessionId);
    expect(run).toMatchObject({ status: 'stopped', exitCode: null });
    expect(names(run)).toEqual(['lint passed', 'test stopped', 'e2e waiting']);
    for (let i = 0; i < 100 && isProcessAlive(child); i++) await sleep(20);
    expect(isProcessAlive(child)).toBe(false);
  });

  it('says the head and what is uncommitted, so a run on an older commit or with changes is seen for what it is', async () => {
    const { client, agent, ended } = await gateDaemon('pass');
    await client.call('gate.run', { sessionId: agent.sessionId });
    const run = await ended(agent.sessionId);
    writeFileSync(join(agent.worktree, 'new.txt'), 'x');
    git(agent.worktree, 'add', '.');
    git(agent.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'more');
    writeFileSync(join(agent.worktree, 'dirty.txt'), 'x');

    const status = await client.call('gate.status', { sessionId: agent.sessionId });

    expect(status).toEqual({ run, command: gateCommand('pass'), head: git(agent.worktree, 'rev-parse', 'HEAD'), branch: agent.branch, uncommitted: 1 });
    expect(status.head).not.toBe(run.commit);
  });

  it('refuses to run without a gate command, saying where to set one', async () => {
    const { client, zone, agent } = await gateDaemon('pass');
    await client.call('zone.configure', { id: zone.id, gateCommand: null });

    await expect(client.call('gate.run', { sessionId: agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('gate command'),
    });
  });

  it('keeps the last run across a restart, and one cut short by it as stopped', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }) });
    const client = await connectTestClient(first);
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    await client.call('zone.configure', { id: zone.id, gateCommand: gateCommand('hang') });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'x', ...SIZE });
    await client.call('gate.run', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test'));
    client.close();
    await first.stop();

    const second = await connectTestClient(await startTestDaemon({ dataDir, agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }) }));

    expect(await second.call('gate.list')).toMatchObject([{ sessionId: agent.sessionId, status: 'stopped' }]);
  });

  it("goes with its agent, logs and all", async () => {
    const { dataDir, client, agent, ended } = await gateDaemon('pass');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await ended(agent.sessionId);
    expect(existsSync(join(dataDir, 'gates', agent.sessionId))).toBe(true);

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    expect(await client.call('gate.list')).toEqual([]);
    expect(existsSync(join(dataDir, 'gates', agent.sessionId))).toBe(false);
  });

  it('survives its agent being deleted while its gate runs, and its logs go once the gate has stopped', async () => {
    const { client, recorder, dataDir, agent } = await gateDaemon('slow');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test' && step.status === 'running'));

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    expect(await client.call('gate.list')).toEqual([]);
    for (let i = 0; i < 200 && existsSync(join(dataDir, 'gates', agent.sessionId)); i++) await sleep(25);
    expect(existsSync(join(dataDir, 'gates', agent.sessionId))).toBe(false);
    expect((await client.call('daemon.health')).pid).toBe(process.pid);
  });

  it('survives a step naming a log it cannot read, saying so in that step', async () => {
    const { client, agent, ended } = await gateDaemon('baddir');
    await client.call('gate.run', { sessionId: agent.sessionId });

    expect((await ended(agent.sessionId)).status).toBe('passed');
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: 'test' })).text).toBe('could not read /usr: not a regular file\n');
    expect((await client.call('daemon.health')).pid).toBe(process.pid);
  });

  it('keeps at most 10 MB of each log, saying where it stopped', { timeout: 20_000 }, async () => {
    const { client, dataDir, agent, ended } = await gateDaemon('flood');
    await client.call('gate.run', { sessionId: agent.sessionId });
    const run = await ended(agent.sessionId);

    expect(run.status).toBe('passed');
    for (const file of ['output.log', join('steps', '0.log')]) {
      const log = readFileSync(join(dataDir, 'gates', agent.sessionId, run.commit, file), 'utf8');
      expect(log.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 100);
      expect(log).toMatch(/… truncated: this log stops at 10 MB\n$/);
    }
  });

  it('counts a pass as dirty when the worktree changed while it ran', async () => {
    const { client, recorder, agent, ended } = await gateDaemon('slow');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test' && step.status === 'running'));
    writeFileSync(join(agent.worktree, 'half-written.ts'), 'export const');

    expect(await ended(agent.sessionId)).toMatchObject({ status: 'passed', dirty: true });
  });

  it("gives a marked step that wrote nothing an empty log, not the run's whole output", async () => {
    const { client, agent, ended } = await gateDaemon('fail');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await ended(agent.sessionId);

    // `test` wrote only to the file it named, which was followed; a step that never ran has no log at all.
    expect((await client.call('gate.log', { sessionId: agent.sessionId, step: 'test' })).text).toContain('case-1');
    const { client: c2, recorder: r2, agent: a2, ended: e2 } = await gateDaemon('hang');
    await c2.call('gate.run', { sessionId: a2.sessionId });
    await r2.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.steps.some((step) => step.name === 'test' && step.status === 'running'));
    await c2.call('gate.stop', { sessionId: a2.sessionId });
    await e2(a2.sessionId);
    expect(await c2.call('gate.log', { sessionId: a2.sessionId, step: 'e2e' })).toEqual({ text: '', next: 0 });
  });

  it("sends a failure to the agent's prompt only for a step that failed", async () => {
    const { client, agent, ended } = await gateDaemon('fail');
    await client.call('gate.run', { sessionId: agent.sessionId });
    await ended(agent.sessionId);

    await expect(client.call('gate.sendFailure', { sessionId: agent.sessionId, step: 'lint' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await client.call('gate.sendFailure', { sessionId: agent.sessionId, step: 'e2e' })).toBeNull();
  });

  it("saves nothing for a run whose agent went between its process ending and its save, and runs no second gate meanwhile (review N1)", async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    // No agents table row for the stand-in agent: its runs stand alone.
    db.exec('PRAGMA foreign_keys = OFF');
    const dir = tempDataDir();
    const worktree = tempRepo();
    const agent = { sessionId: 's1', name: 'Fix checkout', worktree, cwd: worktree } as Agent;
    let release: (() => void) | undefined;
    let reads = 0;
    const saved: GateRun[] = [];
    const host = createGateHost({
      db,
      dir,
      agent: (sessionId) => (sessionId === agent.sessionId ? agent : undefined),
      command: () => ({ command: gateCommand('plain'), zone: 'monorepo' }),
      paste: () => {},
      env: process.env,
      broadcast: (event) => void (event.type === 'gate.updated' && saved.push(event.run)),
      log: () => {},
      // The first read starts the run; the second, as it ends, waits until the test lets it go.
      readWorktree: async () => {
        reads += 1;
        if (reads > 1) await new Promise<void>((resolve) => (release = resolve));
        return { head: 'a'.repeat(40), branch: 'main', uncommitted: 0 };
      },
    });
    const rpc = host.handlers<undefined>();
    await rpc['gate.run']({ sessionId: 's1' }, undefined);
    for (let i = 0; i < 200 && release === undefined; i++) await sleep(10);
    expect(release).toBeDefined();

    // Still running until it is saved: a second gate waits for it.
    await expect(Promise.resolve().then(() => rpc['gate.run']({ sessionId: 's1' }, undefined))).rejects.toThrow('already running');
    host.forget('s1');
    release!();
    for (let i = 0; i < 200 && existsSync(join(dir, 's1')); i++) await sleep(10);

    expect(existsSync(join(dir, 's1'))).toBe(false);
    expect(await rpc['gate.list'](undefined, undefined)).toEqual([]);
    expect(saved.map((run) => run.status)).toEqual(['running']);
    host.stop();
  });

  it('is the user\'s alone: agents can neither run, stop, send a failure, open a PR nor merge', () => {
    const gateMethods: DaemonMethod[] = ['gate.run', 'gate.stop', 'gate.sendFailure', 'gate.openPullRequest', 'gate.merge'];
    for (const method of gateMethods) expect(BOARD_CALLER_METHODS.has(method)).toBe(false);
  });
});

/**
 * A daemon with one agent whose repo's origin is acme/app on the fake GitHub for gh, and a bare repo here for pushes, in
 * a zone whose gate passes. Its worktree has a commit of work, a pull request template and a handover.
 */
async function pullRequestDaemon({ gated = true, printsToken = false }: { gated?: boolean; printsToken?: boolean } = {}) {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE });
  onTestFinished(github.dispose);
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    // With `printsToken`, the agent echoes its board token as its first turn.
    agentEnv: { ...fakeHarnessEnv({ scenario: printsToken ? 'orchestrate' : 'waiting', home: tempDataDir() }), TMPDIR: tempDataDir() },
    gh: github.gh,
    // Asked once at once, then only on refresh.
    pullRequestPollMs: 3_600_000,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const bare = join(tempDataDir(), 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', bare);
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.github', 'pull_request_template.md'), '## Problem\n\n<!-- What. -->\n\n## Change\n\n## How to verify\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'template');
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  if (gated) await client.call('zone.configure', { id: zone.id, gateCommand: gateCommand('pass') });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: printsToken ? 'Print your board identity' : 'Fix checkout', name: 'Fix checkout flake', ...SIZE });
  writeFileSync(join(agent.worktree, 'cart.ts'), 'export const validated = true;\n');
  git(agent.worktree, 'add', '.');
  git(agent.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Validate the cart');
  mkdirSync(join(agent.worktree, '.agent-board'), { recursive: true });
  writeFileSync(join(agent.worktree, '.agent-board', 'handover.md'), '## Problem\n\nCheckout was flaky.\n\n## Change\n\nThe cart is validated first.\n');
  const passed = async () => {
    await client.call('gate.run', { sessionId: agent.sessionId });
    return recorder.waitFor((e): e is GateUpdatedEvent => e.type === 'gate.updated' && e.run.sessionId === agent.sessionId && e.run.status === 'passed').then((e) => e.run);
  };
  return { github, daemon, client, recorder, repo, bare, zone, agent, passed };
}

/** Sets the checks of every pull request on the fake GitHub. */
function setChecks(github: ReturnType<typeof createFakeGitHub>, status: 'COMPLETED' | 'IN_PROGRESS', conclusion: string | null) {
  const state = github.state();
  github.setState({ ...state, pullRequests: state.pullRequests.map((pr) => ({ ...pr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status, conclusion }] })) });
}

/** The number the fake GitHub gives the agent's pull request: after acme/app's issues. */
const PR = 35;

const NO_CLEANUP = { close: false, worktree: false, branch: false, comment: false };
const ALL = { close: true, worktree: true, branch: true, comment: true };

describe('Open PR and Merge (BM3)', { timeout: 20_000 }, () => {
  it("opens an agent's pull request from its board token as a draft, and only its own; merging stays the user's", async () => {
    const { github, client, recorder, daemon, agent, passed } = await pullRequestDaemon({ printsToken: true });
    await passed();
    await client.call('session.attach', { sessionId: agent.sessionId });
    // Not just `:end`: the echoed command line holds that too, before the token line is printed.
    const tokenLine = /^identity:([A-Za-z0-9_-]+):end/m;
    await vi.waitFor(() => expect(recorder.screenText(agent.sessionId)).toMatch(tokenLine), { timeout: 10_000 });
    const token = tokenLine.exec(recorder.screenText(agent.sessionId))![1]!;
    const agentSide = await connectTestClient(daemon);

    // A tab in its window is the user's, who has Open PR.
    const tab = await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    const pane = paneIds(tab.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });
    await client.call('session.write', { sessionId: pane, data: 'echo "token:$AGENT_BOARD_IDENTITY:end"\r' });
    await recorder.waitForText(pane, ':end\r\n');
    const tabToken = /token:(.*):end\r\n/.exec(recorder.screenText(pane))![1]!;
    await expect((await connectTestClient(daemon)).call('board.openPullRequest', { token: tabToken })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    const pr = await agentSide.call('board.openPullRequest', { token });
    expect(pr).toMatchObject({ number: PR, state: 'draft' });
    const create = github.calls().find((call) => call.args[0] === 'pr' && call.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    for (const call of [
      agentSide.call('gate.openPullRequest', { sessionId: agent.sessionId }),
      agentSide.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: '0'.repeat(40), cleanup: NO_CLEANUP }),
      agentSide.call('gate.run', { sessionId: agent.sessionId }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
  });

  it('opens a pull request only once the gate passed on the head: pushed, from the template, the handover and the gate table', async () => {
    const { github, client, bare, agent, passed } = await pullRequestDaemon();
    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'Run the gate first: the PR carries its table for the head commit.',
    });
    const run = await passed();

    const pr = await client.call('gate.openPullRequest', { sessionId: agent.sessionId });

    expect(pr).toMatchObject({ number: PR, title: 'Fix checkout flake', url: `https://github.com/acme/app/pull/${PR}`, state: 'open' });
    expect(git(bare, 'rev-parse', `refs/heads/${agent.branch}`)).toBe(run.commit);
    // Its branch tracks what was pushed, so the agent's own `git push` carries on (review N2).
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', `${agent.branch}@{upstream}`)).toBe(`origin/${agent.branch}`);
    const create = github.calls().find((call) => call.args[0] === 'pr' && call.args[1] === 'create')!;
    expect(create.args).toEqual(['pr', 'create', '--head', agent.branch, '--title', 'Fix checkout flake', '--body-file', '-']);
    expect(create.stdin).toContain('## Change\n\nThe cart is validated first.');
    expect(create.stdin).toContain(`## How to verify\n\nGate \`${gateCommand('pass')}\` on \`${run.commit.slice(0, 7)}\`:`);
    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toThrow(`#${PR} open already`);
  });

  it('refuses to open one with uncommitted changes, whatever the gate said', async () => {
    const { client, agent, passed } = await pullRequestDaemon();
    await passed();
    writeFileSync(join(agent.worktree, 'stray.ts'), '');

    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toThrow('Commit or stash first: the worktree has 1 uncommitted file.');
  });

  it('merges only once the gate passed on the head and GitHub is green, then cleans up as asked', async () => {
    const { github, client, repo, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'IN_PROGRESS', null);
    const merge = (cleanup = NO_CLEANUP) => client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: run.commit, cleanup });

    await expect(merge()).rejects.toThrow("GitHub's checks: build is still running.");
    setChecks(github, 'COMPLETED', 'SUCCESS');
    await expect(client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: 'a'.repeat(40), cleanup: NO_CLEANUP })).rejects.toThrow(/moved on/);
    await expect(merge({ ...NO_CLEANUP, branch: true })).rejects.toThrow(/only with its worktree removed/);
    const merged = await merge({ close: true, worktree: true, branch: true, comment: true });

    expect(merged).toEqual({ done: ['close', 'worktree', 'branch'], failed: [{ step: 'comment', why: 'Fix checkout flake has no linked issue' }] });
    expect(github.calls().map((call) => call.args.join(' '))).toEqual(
      expect.arrayContaining([`pr merge ${PR} --repo acme/app --squash --match-head-commit ${run.commit}`, `api -X DELETE repos/acme/app/git/refs/heads/${agent.branch}`]),
    );
    expect(await client.call('agent.list')).toEqual([]);
    expect(existsSync(agent.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
  });

  it("deletes the pull request's own head branch on GitHub after a local rename, and removes the renamed branch here", async () => {
    const { github, client, repo, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');
    git(agent.worktree, 'branch', '-m', 'renamed-one');

    const merged = await client.call('gate.merge', {
      sessionId: agent.sessionId,
      number: PR,
      headCommit: run.commit,
      cleanup: { close: true, worktree: true, branch: true, comment: false },
    });

    expect(merged).toEqual({ done: ['close', 'worktree', 'branch'], failed: [] });
    const calls = github.calls().map((call) => call.args.join(' '));
    expect(calls).toContain(`api -X DELETE repos/acme/app/git/refs/heads/${agent.branch}`);
    expect(calls.some((call) => call.includes('renamed-one') && call.includes('DELETE'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'renamed-one')).toBe('');
  });

  it('opens a pull request of the branch it owns only: after a checkout of another it refuses', async () => {
    const { client, repo, agent, passed } = await pullRequestDaemon();
    await passed();
    git(repo, 'branch', 'develop');
    git(agent.worktree, 'checkout', 'develop');

    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toThrow(
      `worktree is on develop, not ${agent.branch}: check it out first`,
    );
  });

  it('closes the agent and keeps its worktree, when only that is asked', async () => {
    const { github, client, repo, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');

    const merged = await client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: run.commit, cleanup: { ...NO_CLEANUP, close: true } });

    expect(merged).toEqual({ done: ['close'], failed: [] });
    expect(existsSync(agent.worktree)).toBe(true);
    expect(git(repo, 'branch', '--list', agent.branch)).toContain(agent.branch);
  });

  it('refuses to merge when the gate passed on an older commit than the PR head', async () => {
    const { github, client, agent, passed } = await pullRequestDaemon();
    await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');
    const newer = 'c'.repeat(40);
    github.setState({ ...github.state(), pullRequests: github.state().pullRequests.map((pr) => ({ ...pr, headRefOid: newer })) });

    await expect(client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: newer, cleanup: NO_CLEANUP })).rejects.toThrow(/but the head is now ccccccc/);
  });
  it('keeps the worktree and branch, here and on GitHub, when the agent committed after the merged head', async () => {
    const { github, client, repo, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');
    writeFileSync(join(agent.worktree, 'more.ts'), 'export const more = 1;\n');
    git(agent.worktree, 'add', '.');
    git(agent.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'More work, never merged');
    const later = git(agent.worktree, 'rev-parse', 'HEAD');

    const merged = await client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: run.commit, cleanup: { ...ALL, comment: false } });

    const kept = `its worktree has moved on to ${later.slice(0, 7)} since the merged ${run.commit.slice(0, 7)}, so it is kept, with its branch`;
    expect(merged).toEqual({ done: ['close'], failed: [{ step: 'worktree', why: kept }, { step: 'branch', why: kept }] });
    expect(git(agent.worktree, 'rev-parse', 'HEAD')).toBe(later);
    expect(git(repo, 'branch', '--list', agent.branch)).toContain(agent.branch);
    expect(github.calls().some((call) => call.args.includes('DELETE'))).toBe(false);
  });

  it('keeps the worktree with uncommitted edits in it', async () => {
    const { github, client, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');
    writeFileSync(join(agent.worktree, 'cart.ts'), 'export const validated = false; // half done\n');

    const merged = await client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: run.commit, cleanup: { ...ALL, comment: false } });

    expect(merged.failed.map((each) => each.step)).toEqual(['worktree', 'branch']);
    expect(readFileSync(join(agent.worktree, 'cart.ts'), 'utf8')).toContain('half done');
  });

  it('opens a pull request only from the worktree on its own branch', async () => {
    const { client, agent, passed } = await pullRequestDaemon();
    await passed();
    git(agent.worktree, 'checkout', '-q', '--detach');

    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toThrow(`worktree is on no branch, not ${agent.branch}`);
  });

  it("in a zone with no gate, opens a PR with no gate table and merges once GitHub is green", async () => {
    const { github, client, agent } = await pullRequestDaemon({ gated: false });
    const head = git(agent.worktree, 'rev-parse', 'HEAD');

    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    const create = github.calls().find((call) => call.args[0] === 'pr' && call.args[1] === 'create')!;
    expect(create.stdin).not.toContain('Gate `');
    setChecks(github, 'COMPLETED', 'SUCCESS');

    expect(await client.call('gate.merge', { sessionId: agent.sessionId, number: PR, headCommit: head, cleanup: NO_CLEANUP })).toEqual({ done: [], failed: [] });
  });

  it("lets a PR tab merge a gated agent's pull request once its gate passed on the head", async () => {
    const { github, client, agent, passed } = await pullRequestDaemon();
    const run = await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');

    const details = await client.call('pullRequest.details', { repo: 'acme/app', number: PR });
    expect(details).toMatchObject({ gatedBy: 'Fix checkout flake' });
    expect(details.gateBlocked).toBeUndefined();
    await client.call('pullRequest.merge', { repo: 'acme/app', number: PR, headCommit: run.commit });
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(true);
  });

  it("merges a gated pull request past its gate from a PR tab only once the user confirms it", async () => {
    const { github, client, agent, passed } = await pullRequestDaemon();
    await passed();
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });
    setChecks(github, 'COMPLETED', 'SUCCESS');
    // Someone pushed on the PR since the gate passed: its head is a commit the gate never saw.
    const moved = 'c'.repeat(40);
    const state = github.state();
    github.setState({ ...state, pullRequests: state.pullRequests.map((pr) => ({ ...pr, headRefOid: moved })) });

    expect((await client.call('pullRequest.details', { repo: 'acme/app', number: PR })).gateBlocked).toMatch(/^Gate passed on \w+, but the head is now ccccccc/);
    await expect(client.call('pullRequest.merge', { repo: 'acme/app', number: PR, headCommit: moved })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/^Fix checkout flake's gate hasn't passed on this head: .* Merging here goes past it, so it asks you to confirm\.$/),
    });
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(false);
    await client.call('pullRequest.merge', { repo: 'acme/app', number: PR, headCommit: moved, pastGate: true });
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(true);
  });

  it("leaves a PR tab's merge of an ungated agent's pull request as it was", async () => {
    const { github, client, agent } = await pullRequestDaemon({ gated: false });
    await client.call('gate.openPullRequest', { sessionId: agent.sessionId });

    expect((await client.call('pullRequest.details', { repo: 'acme/app', number: PR })).gatedBy).toBeUndefined();
    void github;
  });
  it("refuses a PR tab's merge of a gated agent's pull request before its pull requests have been read (review N3)", async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE });
    onTestFinished(github.dispose);
    // Its pull requests are never read: the cache the guard once relied on stays cold.
    const client = await connectTestClient(await startTestDaemon({ worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }), gh: github.gh, pullRequestPollMs: 0 }));
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    await client.call('zone.configure', { id: zone.id, gateCommand: gateCommand('pass') });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Fix checkout', name: 'Fix checkout flake', ...SIZE });
    const head = 'b'.repeat(40);
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [{ repo: 'acme/app', number: 41, title: 'Fix checkout', headRefName: agent.branch, headRefOid: head, state: 'OPEN', isDraft: false, statusCheckRollup: [] }],
    });

    expect((await client.call('pullRequest.details', { repo: 'acme/app', number: 41 })).gatedBy).toBe('Fix checkout flake');
    await expect(client.call('pullRequest.merge', { repo: 'acme/app', number: 41, headCommit: head })).rejects.toThrow("Fix checkout flake's gate hasn't passed on this head");
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(false);
  });
});
