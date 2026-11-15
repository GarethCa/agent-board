// A ticket's watches in a running daemon: set from the app's side and with `agent-board watches`, reading the ticket's
// pull request through the fake gh, and showing what they saw on the chat's tile.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_SOCKET_ENV } from '../src/board-env.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { daemonPaths } from '../src/paths.ts';
import type { Agent, AgentUpdatedEvent, DaemonEvent, HookEvent } from '../src/protocol.ts';
import { hashToken } from '../src/tokens.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function setUp() {
  const github = createFakeGitHub();
  onTestFinished(github.dispose);
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), idleNotifyMs: 200 }),
    gh: github.gh,
    pullRequestPollMs: 100,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
  const chat = await client.call('agent.spawn', { zoneId: zone.id, name: 'chat', ticketChat: true, ...SIZE });
  const helper = await client.call('agent.spawn', { zoneId: zone.id, name: 'builder', ticket: chat.sessionId, ...SIZE });
  const loose = await client.call('agent.spawn', { zoneId: zone.id, name: 'loose', ...SIZE });
  const until = async (match: (agent: Agent) => boolean) =>
    (await recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === chat.sessionId && match(e.agent))).agent;
  const cli = async (...args: string[]) => {
    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env: { [BOARD_SOCKET_ENV]: daemon.socketPath } };
    const code = await runBoardCommand(args[0]!, args.slice(1), io);
    return { code, out };
  };
  /**
   * Posts `payload` to the daemon's hook ingress as agent `sessionId`'s harness would, under a token set for it here
   * for this one post: the harness's own token is put back after, so its own hooks still land.
   */
  const hook = async (sessionId: string, payload: Record<string, unknown>) => {
    const token = `token-${sessionId}`;
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    const setToken = db.prepare('UPDATE sessions SET hook_token_sha256 = ? WHERE id = ?');
    const { hook_token_sha256: own } = db.prepare('SELECT hook_token_sha256 FROM sessions WHERE id = ?').get(sessionId) as { hook_token_sha256: string | null };
    try {
      setToken.run(hashToken(token), sessionId);
      const response = await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: sessionId, ...payload }),
      });
      expect(response.status).toBe(200);
    } finally {
      setToken.run(own, sessionId);
      db.close();
    }
  };
  /** The watches' reads of the pull request so far: their `gh pr view` asks for its review decision. */
  const watchReads = () => github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'view' && call.args.join(' ').includes('reviewDecision')).length;
  return { github, client, chat, helper, loose, until, cli, hook, watchReads, recorder };
}

const pullRequest = (branch: string, reviews: FakeGitHubPullRequest['reviews'] = []): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  number: 214,
  title: 'Lock out after five tries',
  headRefName: branch,
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  reviews,
});

describe("a ticket's watches in the daemon", () => {
  it('are off on a new ticket, on its chat alone, and read no pull request', async () => {
    const { client, chat, github } = await setUp();
    const list = await client.call('agent.list');
    expect(list.find((agent) => agent.sessionId === chat.sessionId)?.watch).toMatchObject({ settings: { reviews: { tile: false, chat: false }, everyMinutes: 5 }, news: [], ask: null });
    expect(list.filter((agent) => agent.watch !== undefined).map((agent) => agent.name)).toEqual(['chat']);
    expect(github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'view')).toEqual([]);
  });

  it("read the ticket's pull request once turned on, and show a new review on the tile as its ask", async () => {
    const { client, chat, helper, github, until } = await setUp();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch)] });
    await until((agent) => agent.pullRequests.length > 0);

    const set = await client.call('ticket.setWatches', { sessionId: helper.sessionId, watches: { reviews: 'tile' } });
    expect(set.agent.sessionId).toBe(chat.sessionId);
    const watching = await until((agent) => agent.watch?.checkedAt !== null);
    expect(watching.watch).toMatchObject({ pullRequest: { repo: 'acme/app', number: 214, state: 'open' }, news: [], ask: null, problem: null });

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch, [{ author: 'sam', state: 'CHANGES_REQUESTED', body: 'Cap the retries.', submittedAt: '2026-11-14T11:02:00Z' }])] });
    // Changing the pace checks again at once, as a push does.
    await client.call('ticket.setWatches', { sessionId: chat.sessionId, everyMinutes: 2 });
    const reviewed = await until((agent) => (agent.watch?.news.length ?? 0) > 0);
    expect(reviewed.watch).toMatchObject({ news: [{ kind: 'reviews', text: 'sam requested changes', by: 'sam' }], ask: 'new-review' });

    const read = await client.call('ticket.readWatches', { sessionId: chat.sessionId });
    expect(read.agent.watch).toMatchObject({ news: [], ask: null });
  });

  it('check at once after a ticket agent pushes, and tell a busy chat its news once its turn ends', async () => {
    const { client, chat, helper, github, until, hook, watchReads, recorder } = await setUp();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch)] });
    await until((agent) => agent.pullRequests.length > 0);
    await client.call('ticket.setWatches', { sessionId: chat.sessionId, watches: { reviews: 'chat' } });
    await until((agent) => agent.watch?.checkedAt !== null);
    const before = watchReads();

    // The chat is mid-turn when the review comes.
    await hook(chat.sessionId, { hook_event_name: 'UserPromptSubmit', prompt: 'Keep going.' });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch, [{ author: 'sam', state: 'CHANGES_REQUESTED', body: 'Cap the retries.', submittedAt: '2026-11-14T11:02:00Z' }])] });
    // The helper pushes: the watches read straight away, not at their next check five minutes on.
    await hook(helper.sessionId, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push -u origin HEAD' }, tool_response: {} });
    await expect.poll(watchReads, { timeout: 10_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await client.call('agent.list')).find((agent) => agent.sessionId === chat.sessionId)?.watch?.seen?.lastReview?.by, { timeout: 10_000 }).toBe('sam');

    // Its turn ends: it hears the news as its next message, in the harness.
    await hook(chat.sessionId, { hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    const told = await recorder.waitFor(
      (e: DaemonEvent): e is HookEvent =>
        e.type === 'hook' && e.sessionId === chat.sessionId && e.payload.hook_event_name === 'UserPromptSubmit' && String(e.payload.prompt).includes("Your ticket's watches saw news"),
    );
    expect(String(told.payload.prompt)).toContain('> sam: Cap the retries.');
  }, 30_000);

  it('are shown and changed with `agent-board watches`, for a ticket only', async () => {
    const { cli } = await setUp();
    const shown = await cli('watches', 'chat');
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('none; no pull request yet');

    const changed = await cli('watches', 'chat', 'reviews=both', 'checks=tile', '--every', '15');
    expect(changed.code).toBe(0);
    expect(changed.out).toContain('reviews=both checks=tile, every 15 min');

    const json = JSON.parse((await cli('watches', 'chat', '--json')).out) as { watch: Agent['watch'] };
    expect(json.watch?.settings).toMatchObject({ reviews: { tile: true, chat: true }, checks: { tile: true, chat: false }, everyMinutes: 15 });

    expect((await cli('watches', 'chat', 'deploys=tile')).out).toContain('"deploys=tile" is not a watch');
    expect((await cli('watches', 'chat', '--every', '7')).out).toContain('--every takes 2, 5, 15');
    const refused = await cli('watches', 'loose', 'reviews=tile');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("is in no ticket: only a ticket's chat or helpers have watches");
  });
});
