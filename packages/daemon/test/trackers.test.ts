import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createGitHubTracker } from '@agent-board/tracker';
import {
  createFakeGitHub,
  createFakeTracker,
  createMemoryCredentialStore,
  FAKE_GITHUB_STATE,
  type FakeGitHubState,
} from '@agent-board/tracker/testing';
import { DaemonRpcError, type DaemonClient } from '../src/client.ts';
import type { DaemonOptions } from '../src/daemon.ts';
import { RPC_ERROR, TRACKER_ERROR, type AgentUpdatedEvent, type DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };
const GOOD_KEY = 'lin_api_good';

/**
 * A daemon whose Linear is the fake tracker, which only accepts `GOOD_KEY`, with credentials in memory and agents
 * running the fake claude.
 */
async function trackerDaemon(options: Partial<DaemonOptions> = {}) {
  const credentials = options.credentials ?? createMemoryCredentialStore();
  const home = tempDataDir();
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'waiting', home, idleNotifyMs: 200 }),
    credentials,
    trackers: { linear: (credential) => createFakeTracker({ refuse: credential !== GOOD_KEY }) },
    ...options,
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, credentials, home };
}

/** A daemon whose GitHub is a fake gh on `state`, with agents running the fake claude. */
async function gitHubDaemon(state: FakeGitHubState = FAKE_GITHUB_STATE) {
  const github = createFakeGitHub(state);
  onTestFinished(github.dispose);
  const { client } = await trackerDaemon({ trackers: { github: () => createGitHubTracker({ gh: github.gh }) } });
  return { client, github };
}

async function rpcError(call: Promise<unknown>): Promise<DaemonRpcError> {
  const error = await call.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  return error as DaemonRpcError;
}

async function linearZone(client: DaemonClient) {
  await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
}

describe('connecting a tracker', () => {
  it('checks the credential with the tracker, then keeps it in the credential store', async () => {
    const { client, credentials } = await trackerDaemon();
    expect(await client.call('tracker.status', { provider: 'linear' })).toEqual({
      provider: 'linear',
      connected: false,
    });

    const refused = await rpcError(client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_bad' }));
    expect(refused.code).toBe(TRACKER_ERROR.unauthorized);
    expect(await credentials.get('linear')).toBeUndefined();

    const teams = await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    expect(teams.map((team) => team.key)).toEqual(['ACME', 'OPS']);
    expect(await client.call('tracker.status', { provider: 'linear' })).toEqual({
      provider: 'linear',
      connected: true,
    });
    expect(await credentials.get('linear')).toBe(GOOD_KEY);
    expect(await client.call('tracker.scopes', { provider: 'linear' })).toEqual(teams);

    await client.call('tracker.disconnect', { provider: 'linear' });
    expect(await credentials.get('linear')).toBeUndefined();
    const disconnected = await rpcError(client.call('tracker.scopes', { provider: 'linear' }));
    expect(disconnected.code).toBe(TRACKER_ERROR.notConnected);
  });

  it('never writes the credential to the database', async () => {
    const dataDir = tempDataDir();
    const { client, daemon } = await trackerDaemon({ dataDir });
    await linearZone(client);
    await daemon.stop();

    for (const file of readdirSync(dataDir).filter((name) => name.includes('.db'))) {
      expect(readFileSync(join(dataDir, file)).includes(GOOD_KEY)).toBe(false);
    }
  });

  it('refuses an unknown provider', async () => {
    const { client } = await trackerDaemon();
    const error = await rpcError(client.call('tracker.status', { provider: 'jira' as 'linear' }));
    expect(error.code).toBe(RPC_ERROR.invalidParams);
  });
});

describe('a zone tracker', () => {
  it('binds a zone to a team the credential can see, and remembers it', async () => {
    const { client } = await trackerDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    expect(zone.tracker).toBeNull();

    const notConnected = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } }),
    );
    expect(notConnected.code).toBe(TRACKER_ERROR.notConnected);

    await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    const unknownTeam = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'NOPE' } }),
    );
    expect(unknownTeam.code).toBe(RPC_ERROR.invalidParams);

    const bound = await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    expect(bound.tracker).toEqual({ provider: 'linear', scope: 'ACME' });
    expect(await client.call('zone.list')).toEqual([bound]);

    const unbound = await client.call('zone.setTracker', { id: zone.id, tracker: null });
    expect(unbound.tracker).toBeNull();
  });

  it('binds an unbound zone to a team too, and keeps it once the zone is bound to a repo', async () => {
    const { client } = await trackerDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', x: 0, y: 0 });

    const withTeam = await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    const bound = await client.call('zone.bind', { id: zone.id, as: 'repo', path: tempRepo() });

    expect(withTeam).toMatchObject({ kind: 'unbound', tracker: { provider: 'linear', scope: 'ACME' } });
    expect(bound).toMatchObject({ kind: 'repo', tracker: { provider: 'linear', scope: 'ACME' } });
  });

  it("lists the zone's open issues, and searches them", async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);

    const open = await client.call('tracker.issues', { zoneId: zone.id });
    expect(open.map((issue) => issue.id)).toEqual(['ACME-16', 'ACME-12']);
    const found = await client.call('tracker.issues', { zoneId: zone.id, query: 'keychain' });
    expect(found.map((issue) => issue.id)).toEqual(['ACME-16']);
    // A blank query lists.
    expect(await client.call('tracker.issues', { zoneId: zone.id, query: '  ' })).toEqual(open);
  });

  it("lists a team's open projects", async () => {
    const { client } = await trackerDaemon();
    const notConnected = await rpcError(client.call('tracker.projects', { provider: 'linear', scope: 'ACME' }));
    expect(notConnected.code).toBe(TRACKER_ERROR.notConnected);

    await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    const projects = await client.call('tracker.projects', { provider: 'linear', scope: 'ACME' });
    expect(projects.map((project) => project.id)).toEqual(['fake-project-tracker', 'fake-project-agents']);
    expect(await client.call('tracker.projects', { provider: 'linear', scope: 'OPS' })).toEqual([]);
  });

  it("binds a zone to a team's project, and lists only that project's issues", async () => {
    const { client } = await trackerDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    const zone = await client.call('zone.addUnbound', { name: 'Tracker integration', x: 0, y: 0 });

    const missing = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME', project: 'nope' } }),
    );
    expect(missing.code).toBe(RPC_ERROR.invalidParams);
    expect(missing.message).toContain('no project nope');
    // A project of another team is no project of this one.
    const other = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'OPS', project: 'fake-project-tracker' } }),
    );
    expect(other.code).toBe(RPC_ERROR.invalidParams);

    const tracker = { provider: 'linear' as const, scope: 'ACME', project: 'fake-project-tracker' };
    const bound = await client.call('zone.setTracker', { id: zone.id, tracker });
    expect(bound.tracker).toEqual(tracker);
    expect(await client.call('zone.list')).toEqual([bound]);

    const issues = await client.call('tracker.issues', { zoneId: zone.id });
    expect(issues.map((issue) => issue.id)).toEqual(['ACME-16']);
    const found = await client.call('tracker.issues', { zoneId: zone.id, query: 'spawn' });
    expect(found).toEqual([]);

    // Binding to the team alone widens it again.
    const widened = await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    expect(widened.tracker).toEqual({ provider: 'linear', scope: 'ACME' });
    expect((await client.call('tracker.issues', { zoneId: zone.id })).map((issue) => issue.id)).toEqual(['ACME-16', 'ACME-12']);
  });

  it('makes a zone for a project, and remembers its project across a restart', async () => {
    const dataDir = tempDataDir();
    const tracker = { provider: 'linear' as const, scope: 'ACME', project: 'fake-project-agents' };
    const first = await trackerDaemon({ dataDir });
    await first.client.call('tracker.connect', { provider: 'linear', credential: GOOD_KEY });
    const zone = await first.client.call('zone.addUnbound', { name: 'Agents', x: 0, y: 0, tracker });
    expect(zone.tracker).toEqual(tracker);
    await first.daemon.stop();

    const second = await trackerDaemon({ dataDir, credentials: first.credentials });
    expect((await second.client.call('zone.list'))[0]?.tracker).toEqual(tracker);
  });

  it('has no projects to list or bind for GitHub', async () => {
    const { client } = await gitHubDaemon();
    const list = await rpcError(client.call('tracker.projects', { provider: 'github', scope: 'acme/app' }));
    expect(list.code).toBe(RPC_ERROR.invalidParams);
    const zone = await client.call('zone.addUnbound', { name: 'App', x: 0, y: 0 });
    const bind = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'github', scope: 'acme/app', project: 'p' } }),
    );
    expect(bind.code).toBe(RPC_ERROR.invalidParams);
  });

  it('refuses to list issues for a zone without a tracker', async () => {
    const { client } = await trackerDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const error = await rpcError(client.call('tracker.issues', { zoneId: zone.id }));
    expect(error.code).toBe(RPC_ERROR.invalidParams);
    expect(error.message).toContain('no tracker');
  });

  it('reports a revoked credential as unauthorized', async () => {
    const credentials = createMemoryCredentialStore();
    const { client } = await trackerDaemon({ credentials });
    const zone = await linearZone(client);
    await credentials.set('linear', 'lin_api_revoked');
    // The credential is read from the store on every call, so a key changed in the keychain takes effect at once.
    const error = await rpcError(client.call('tracker.issues', { zoneId: zone.id }));
    expect(error.code).toBe(TRACKER_ERROR.unauthorized);
  });
});

describe('agents and issues', () => {
  it('starts an agent from an issue: its branch is named from the issue, and the issue is its first prompt', async () => {
    const { client, home } = await trackerDaemon();
    const zone = await linearZone(client);

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'ACME-12', ...SIZE });

    expect(agent.branch).toBe('acme-12-spawn-agents-in-a-pty');
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('acme-12-spawn-agents-in-a-pty');
    expect(agent.name).toBe('ACME-12: Spawn agents in a PTY');
    // ACME-12 has no description, so the tile describes it by its prompt.
    expect(agent.description).toBe(
      'ACME-12: Spawn agents in a PTY\nhttps://linear.app/acme/issue/ACME-12/spawn-agents-in-a-pty',
    );
    expect(agent.issue).toEqual({
      provider: 'linear',
      id: 'ACME-12',
      title: 'Spawn agents in a PTY',
      url: 'https://linear.app/acme/issue/ACME-12/spawn-agents-in-a-pty',
    });
    expect(await firstPrompt(home, agent.cwd, agent.sessionId)).toBe(
      'ACME-12: Spawn agents in a PTY\nhttps://linear.app/acme/issue/ACME-12/spawn-agents-in-a-pty',
    );
  });

  it('adds the typed task after the issue, and gives a second agent on the same issue a branch of its own', async () => {
    const { client, home } = await trackerDaemon();
    const zone = await linearZone(client);
    const first = await client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'ACME-16', ...SIZE });

    const second = await client.call('agent.spawn', {
      zoneId: zone.id,
      prompt: 'Only the UI part',
      issueId: 'ACME-16',
      ...SIZE,
    });

    expect(first.branch).toBe('acme-16-tracker-interface-with-linear-link-and');
    expect(second.branch).toBe('acme-16-tracker-interface-with-linear-link-and-2');
    expect(first.description).toBe('Credentials (Linear API key or OAuth) are stored in the OS keychain.');
    expect(second.description).toBe('Only the UI part');
    expect(await firstPrompt(home, second.cwd, second.sessionId)).toMatch(
      /^ACME-16: Tracker interface[^]*\n\nOnly the UI part$/,
    );
  });

  it('gives two agents started on one issue at the same time a branch each', async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);

    const spawn = () => client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'ACME-12', ...SIZE });
    const agents = await Promise.all([spawn(), spawn(), spawn()]);

    expect(agents.map((agent) => agent.branch).sort()).toEqual([
      'acme-12-spawn-agents-in-a-pty',
      'acme-12-spawn-agents-in-a-pty-2',
      'acme-12-spawn-agents-in-a-pty-3',
    ]);
  });

  it("refuses an issue from a team other than the zone's, for starting and for linking", async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);

    const spawned = await rpcError(
      client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'OPS-3', ...SIZE }),
    );
    expect(spawned.code).toBe(RPC_ERROR.invalidParams);
    expect(spawned.message).toBe('ACME has no issue OPS-3');
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });
    const linked = await rpcError(client.call('agent.link', { sessionId: agent.sessionId, issueId: 'OPS-3' }));
    expect(linked.message).toBe('ACME has no issue OPS-3');
  });

  it('refuses an issue the tracker does not have, and leaves no worktree behind', async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);
    const error = await rpcError(
      client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'ACME-404', ...SIZE }),
    );
    expect(error.code).toBe(RPC_ERROR.invalidParams);
    expect(error.message).toContain('ACME-404');
    expect(await client.call('agent.list')).toEqual([]);
  });

  it('links a running agent to an issue and unlinks it, telling every client, across a restart', async () => {
    const dataDir = tempDataDir();
    const credentials = createMemoryCredentialStore();
    const first = await trackerDaemon({ dataDir, credentials });
    const zone = await linearZone(first.client);
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });
    expect(agent.issue).toBeNull();
    const recorder = recordEvents(first.client);

    const linked = await first.client.call('agent.link', { sessionId: agent.sessionId, issueId: 'ACME-16' });

    expect(linked.issue).toMatchObject({ provider: 'linear', id: 'ACME-16' });
    await recorder.waitFor(
      (event: DaemonEvent): event is AgentUpdatedEvent =>
        event.type === 'agent.updated' && event.agent.issue?.id === 'ACME-16',
    );
    // Linking never renames the branch the agent is already working on.
    expect(linked.branch).toBe(agent.branch);

    await first.daemon.stop();
    const second = await trackerDaemon({ dataDir, credentials });
    const [restored] = await second.client.call('agent.list');
    expect(restored?.issue).toEqual(linked.issue);

    const unlinked = await second.client.call('agent.link', { sessionId: agent.sessionId, issueId: null });
    expect(unlinked.issue).toBeNull();
  });

  it("links from its own repo's zone's tracker when it sits loose on the board or in an unbound zone", async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);
    const unbound = await client.call('zone.addUnbound', { name: 'Ideas', x: 0, y: 900 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });

    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: -400, y: 0 });
    expect((await client.call('agent.link', { sessionId: agent.sessionId, issueId: 'ACME-16' })).issue?.id).toBe('ACME-16');
    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: unbound.id, x: 0, y: 0 });
    expect((await client.call('agent.link', { sessionId: agent.sessionId, issueId: null })).issue).toBeNull();
    expect((await client.call('agent.link', { sessionId: agent.sessionId, issueId: 'ACME-16' })).issue?.id).toBe('ACME-16');
  });

  it("refuses to link, saying why, once its repo has no zone left on the board", async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });
    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: -400, y: 0 });
    await client.call('zone.remove', { id: zone.id });

    const refused = await rpcError(client.call('agent.link', { sessionId: agent.sessionId, issueId: 'ACME-16' }));
    expect(refused.code).toBe(RPC_ERROR.invalidParams);
    expect(refused.message).toBe(`no zone on the board is bound to ${agent.repoRoot}, to take issues from`);
    // Unlinking needs no tracker.
    expect((await client.call('agent.link', { sessionId: agent.sessionId, issueId: null })).issue).toBeNull();
  });

  it('refuses to link an unknown agent or issue', async () => {
    const { client } = await trackerDaemon();
    const zone = await linearZone(client);
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });
    expect((await rpcError(client.call('agent.link', { sessionId: 'nope', issueId: 'ACME-16' }))).code).toBe(
      RPC_ERROR.invalidParams,
    );
    expect((await rpcError(client.call('agent.link', { sessionId: agent.sessionId, issueId: 'ACME-404' }))).code).toBe(
      RPC_ERROR.invalidParams,
    );
  });
});

describe('GitHub Issues', () => {
  it("uses gh's own login: connected while gh is logged in, and never asks for a token", async () => {
    const { client, github } = await gitHubDaemon();
    expect(await client.call('tracker.status', { provider: 'github' })).toEqual({ provider: 'github', connected: true });
    // Asking whether gh is logged in costs one small call, not a listing of repos.
    expect(github.calls().map((call) => call.args.slice(0, 2).join(' '))).toEqual(['api user']);
    expect((await client.call('tracker.scopes', { provider: 'github' })).map((repo) => repo.key)).toEqual([
      'acme/app',
      'acme/ops',
    ]);
    const connect = await rpcError(client.call('tracker.connect', { provider: 'github', credential: 'ghp_x' }));
    expect(connect.code).toBe(RPC_ERROR.invalidParams);
    expect(connect.message).toContain('gh auth login');

    github.setState({ ...FAKE_GITHUB_STATE, loggedIn: false });
    expect(await client.call('tracker.status', { provider: 'github' })).toEqual({ provider: 'github', connected: false });
    const refused = await rpcError(client.call('tracker.scopes', { provider: 'github' }));
    expect(refused.code).toBe(TRACKER_ERROR.unauthorized);
    expect(refused.message).toContain('gh auth login');
  });

  it('binds a zone to a repo, spelled as GitHub spells it, and refuses an unknown repo', async () => {
    const { client } = await gitHubDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });

    const bound = await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'github', scope: 'Acme/App' } });
    expect(bound.tracker).toEqual({ provider: 'github', scope: 'acme/app' });

    const unknown = await rpcError(
      client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'github', scope: 'acme/nope' } }),
    );
    expect(unknown.code).toBe(RPC_ERROR.invalidParams);
    expect(unknown.message).toBe('GitHub has no acme/nope gh can see');
  });

  it('starts an agent from a GitHub issue on a gh-<n>-<slug> branch, linked to the issue', async () => {
    const { client } = await gitHubDaemon();
    const added = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const zone = await client.call('zone.setTracker', { id: added.id, tracker: { provider: 'github', scope: 'acme/app' } });
    expect((await client.call('tracker.issues', { zoneId: zone.id })).map((issue) => issue.id)).toEqual([
      'acme/app#34',
      'acme/app#12',
    ]);

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'acme/app#34', ...SIZE });

    expect(agent.branch).toBe('gh-34-fix-the-login-redirect');
    expect(agent.name).toBe('#34: Fix the login redirect');
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('gh-34-fix-the-login-redirect');
    expect(agent.issue).toEqual({
      provider: 'github',
      id: 'acme/app#34',
      title: 'Fix the login redirect',
      url: 'https://github.com/acme/app/issues/34',
    });
    const otherRepo = await rpcError(
      client.call('agent.link', { sessionId: agent.sessionId, issueId: 'acme/ops#5' }),
    );
    expect(otherRepo.message).toBe('acme/app has no issue acme/ops#5');
  });
});

/** The first prompt the fake claude was started with, from its transcript. */
async function firstPrompt(home: string, cwd: string, sessionId: string): Promise<string> {
  const path = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  for (let waited = 0; ; waited += 50) {
    try {
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const prompt = lines.find((line) => line.type === 'user') as { message: { content: string } } | undefined;
      if (prompt !== undefined) return prompt.message.content;
    } catch {
      // Not written yet.
    }
    if (waited > 10_000) throw new Error(`no prompt in ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
