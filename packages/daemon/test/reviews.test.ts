import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import type { DaemonOptions } from '../src/daemon.ts';
import { parseReviewDoc } from '../src/review-doc.ts';
import {
  DEFAULT_REVIEW_CAP,
  RPC_ERROR,
  type Agent,
  type AgentUpdatedEvent,
  type DaemonEvent,
  type HookEvent,
  type ReviewRound,
  type ReviewUpdatedEvent,
} from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

type Recorder = ReturnType<typeof recordEvents>;

/** A daemon whose agents run the fake claude's `review` scenario: a reviewer's prompt ends on a review doc. */
async function reviewDaemon(options: Partial<DaemonOptions> = {}) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'review', home: tempDataDir(), idleNotifyMs: 200 }),
    ...options,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  const implementer = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', name: 'Coder', ...SIZE });
  // Its idle prompt has come after its turn: it sits at its prompt.
  await untilAgent(recorder, implementer.sessionId, (agent) => agent.state === 'waiting');
  return { daemon, client, recorder, repo, zone, implementer };
}

async function untilAgent(recorder: Recorder, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

async function untilRound(recorder: Recorder, id: string, match: (round: ReviewRound) => boolean): Promise<ReviewRound> {
  const event = await recorder.waitFor((e): e is ReviewUpdatedEvent => e.type === 'review.updated' && e.round.id === id && match(e.round));
  return event.round;
}

const refused = (call: Promise<unknown>, message: string | RegExp) =>
  expect(call).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(message) });

/** Each round waits for the fake reviewer to type its doc: two rounds take more than the default 5s on a busy machine. */
const ROUNDS_MS = 30_000;

describe('review rounds', { timeout: ROUNDS_MS }, () => {
  it('spawns a reviewer on a branch from the implementer, which leaves its doc and is stopped', async () => {
    const { client, recorder, repo, implementer } = await reviewDaemon();
    const startedFrom = git(implementer.worktree, 'rev-parse', 'HEAD');
    // The implementer's work, committed on its branch: the reviewer must see it.
    git(implementer.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-q', '-m', 'the work');
    // The user's own checkout moves on: the work is still compared with what it started from.
    git(repo, 'checkout', '-q', '--detach');

    const round = await client.call('review.start', { sessionId: implementer.sessionId });

    expect(round).toMatchObject({ implementer: implementer.sessionId, round: 1, status: 'reviewing', doc: null, reviewer: expect.any(String) });
    // What it reviews, and all a merge may take: the implementer's tip.
    expect(round.head).toBe(git(implementer.worktree, 'rev-parse', 'HEAD'));
    const [reviewer] = (await client.call('agent.list')).filter((agent) => agent.reviewOf === implementer.sessionId);
    expect(reviewer).toMatchObject({ sessionId: round.reviewer, harness: 'claude', zoneId: implementer.zoneId, name: 'Coder · review r1' });
    expect(reviewer!.branch).toBe(`${implementer.branch}-review-r1`);
    expect(git(reviewer!.worktree, 'log', '-1', '--format=%s')).toBe('the work');

    const ready = await untilRound(recorder, round.id, (r) => r.status === 'ready');
    expect(parseReviewDoc(ready.doc!).verdict).toBe('changes-requested');
    expect(ready.finishedAt).not.toBeNull();
    // Ephemeral: once its doc is in, it is stopped, and is done, not failed.
    await untilAgent(recorder, round.reviewer!, (agent) => agent.endedAt !== null && agent.state === 'done');
    // Its prompt said what to review, and the doc's format.
    const prompt = recorder.events.find(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === round.reviewer && e.payload.hook_event_name === 'UserPromptSubmit',
    )!.payload.prompt as string;
    expect(prompt).toContain('round 1 of the work of Coder');
    expect(prompt).toContain(`\`${implementer.branch}\``);
    expect(prompt).toContain(`git diff ${startedFrom}...HEAD`);
    expect(await client.call('review.list')).toEqual([ready]);
  });

  it('leaves a stopped reviewer ended, with no shell in its pane, and refuses to restart it', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilAgent(recorder, round.reviewer!, (agent) => agent.endedAt !== null);

    await refused(client.call('agent.resume', { sessionId: round.reviewer! }), /reviewer whose round is over/);
    // An ended agent's shell opens just after its exit finishes: by now one would have.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === round.reviewer)).toMatchObject({ shellSessionId: null });
    expect((await client.call('session.list')).filter((session) => session.harness === null)).toEqual([]);
  });

  it('puts the reviewer of an implementer loose on the board beside it, with the role of reviewer', async () => {
    const { client, recorder, repo } = await reviewDaemon();
    const loose = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: 'Tidy up', position: { x: 500, y: 600 }, ...SIZE });
    await untilAgent(recorder, loose.sessionId, (agent) => agent.state === 'waiting');

    const round = await client.call('review.start', { sessionId: loose.sessionId });

    const reviewer = (await client.call('agent.list')).find((agent) => agent.sessionId === round.reviewer);
    expect(reviewer).toMatchObject({ zoneId: null, role: 'reviewer', position: { x: 548, y: 648 } });
  });

  it('sends the doc to the implementer as its next message, headed as a hand-off from its reviewer', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    const ready = await untilRound(recorder, round.id, (r) => r.status === 'ready');

    const sent = await client.call('review.send', { id: round.id });

    expect(sent.sentAt).not.toBeNull();
    const delivered = await recorder.waitFor(
      (e): e is HookEvent =>
        e.type === 'hook' && e.sessionId === implementer.sessionId && e.payload.hook_event_name === 'UserPromptSubmit' && e.payload.prompt !== 'Write the code',
    );
    expect(delivered.payload.prompt).toBe(`Hand-off from Coder · review r1 (its review, round 1): ${ready.doc!.replace(/\s+/g, ' ')}`);
  });

  it('refuses to send a doc the implementer can not take now, saying why', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, round.id, (r) => r.status === 'ready');
    await client.call('session.write', { sessionId: implementer.sessionId, data: 'half a thought' });

    await refused(client.call('review.send', { id: round.id }), /not sent: you were typing in its terminal/);
    expect((await client.call('review.list'))[0]!.sentAt).toBeNull();
  });

  it('numbers rounds per implementer, one at a time, up to its cap, which the user can change', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    expect(implementer.reviewCap).toBe(DEFAULT_REVIEW_CAP);
    await refused(client.call('review.setCap', { sessionId: implementer.sessionId, cap: 0 }), /1 to 10/);
    expect(await client.call('review.setCap', { sessionId: implementer.sessionId, cap: 1 })).toMatchObject({ reviewCap: 1 });

    const first = await client.call('review.start', { sessionId: implementer.sessionId });
    await refused(client.call('review.start', { sessionId: implementer.sessionId }), /Round 1 is still under review/);
    await untilRound(recorder, first.id, (r) => r.status === 'ready');
    await refused(client.call('review.start', { sessionId: implementer.sessionId }), /All 1 review round used/);
    await refused(client.call('review.start', { sessionId: first.reviewer! }), /reviewer/);

    await client.call('review.setCap', { sessionId: implementer.sessionId, cap: 2 });
    const second = await client.call('review.start', { sessionId: implementer.sessionId });
    expect(second.round).toBe(2);
    const ready = await untilRound(recorder, second.id, (r) => r.status === 'ready');
    // A later round is given the last one's doc, and says which findings it resolved.
    expect(parseReviewDoc(ready.doc!).verdict).toBe('approve');
    // The first round's reviewer went as the second started; its doc stays.
    expect((await client.call('agent.list')).map((agent) => agent.sessionId)).toEqual([implementer.sessionId, second.reviewer]);
    expect((await client.call('review.list'))[0]).toMatchObject({ id: first.id, reviewer: null, status: 'ready' });
  });

  it.each(['dismissed', 'deleted'] as const)('fails a round whose reviewer a restart stopped once it is %s, so another can start', async (how) => {
    const dataDir = tempDataDir();
    const worktreesDir = tempDataDir();
    const env = fakeHarnessEnv({ scenario: 'review', home: tempDataDir(), idleNotifyMs: 200 });
    const { daemon, client, implementer } = await reviewDaemon({ dataDir, worktreesDir, agentEnv: env });
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    await daemon.stop();
    const again = await connectTestClient(await startTestDaemon({ dataDir, worktreesDir, agentEnv: env }));
    expect((await again.call('review.list'))[0]).toMatchObject({ status: 'reviewing' });

    if (how === 'dismissed') await again.call('review.dismiss', { id: round.id });
    else await again.call('agent.delete', { sessionId: round.reviewer!, force: true });

    expect((await again.call('review.list'))[0]).toMatchObject({ status: 'failed', reviewer: null, failedBecause: expect.stringContaining(how) });
    expect((await again.call('review.start', { sessionId: implementer.sessionId })).round).toBe(2);
  });

  it('fails a round whose reviewer ends without a doc', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });

    await client.call('agent.delete', { sessionId: round.reviewer!, force: true });

    const failed = await untilRound(recorder, round.id, (r) => r.status === 'failed' && r.reviewer === null);
    expect(failed).toMatchObject({ reviewer: null, doc: null, failedBecause: expect.any(String) });
    // A failed round doesn't hold up the next.
    expect((await client.call('review.start', { sessionId: implementer.sessionId })).round).toBe(2);
  });

  it("dismisses a round: its reviewer and that one's worktree go, its doc stays", async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, round.id, (r) => r.status === 'ready');

    const dismissed = await client.call('review.dismiss', { id: round.id });

    expect(dismissed).toMatchObject({ reviewer: null, status: 'ready', dismissedAt: expect.any(String), doc: expect.any(String) });
    expect((await client.call('agent.list')).map((agent) => agent.sessionId)).toEqual([implementer.sessionId]);
  });

  it('deletes the reviewers and rounds with their implementer', async () => {
    const { client, recorder, implementer } = await reviewDaemon();
    const round = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, round.id, (r) => r.status === 'ready');

    await client.call('agent.delete', { sessionId: implementer.sessionId, force: true });

    expect(await client.call('agent.list')).toEqual([]);
    expect(await client.call('review.list')).toEqual([]);
    const removed = recorder.events.filter((e: DaemonEvent) => e.type === 'agent.removed').map((e) => (e as { sessionId: string }).sessionId);
    expect(removed).toEqual([round.reviewer, implementer.sessionId]);
  });
});

describe('approving and merging', { timeout: ROUNDS_MS }, () => {
  async function withPullRequest(checks: Record<string, unknown>[]) {
    const github = createFakeGitHub(FAKE_GITHUB_STATE);
    onTestFinished(github.dispose);
    const setup = await reviewDaemon({ gh: github.gh, pullRequestPollMs: 60_000 });
    git(setup.repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    /** The PR as GitHub has it: its head at the implementer's tip, unless said otherwise. */
    const setPullRequest = (fields: Partial<FakeGitHubPullRequest> = {}) =>
      github.setState({
        ...FAKE_GITHUB_STATE,
        pullRequests: [
          {
            repo: 'acme/app',
            number: 41,
            title: 'The work',
            headRefName: setup.implementer.branch,
            headRefOid: git(setup.implementer.worktree, 'rev-parse', 'HEAD'),
            state: 'OPEN',
            isDraft: false,
            statusCheckRollup: checks,
            ...fields,
          },
        ],
      });
    setPullRequest();
    // Its turn ends: the daemon asks gh for its pull requests.
    await setup.client.call('agent.answer', { sessionId: setup.implementer.sessionId, text: 'Open the PR' });
    await untilAgent(setup.recorder, setup.implementer.sessionId, (agent) => agent.pullRequests.length === 1);
    return { ...setup, github, setPullRequest };
  }

  /** Two rounds, the second approving. */
  async function approved(setup: Awaited<ReturnType<typeof withPullRequest>>) {
    const { client, recorder, implementer } = setup;
    await client.call('review.setCap', { sessionId: implementer.sessionId, cap: 2 });
    const first = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, first.id, (r) => r.status === 'ready');
    const second = await client.call('review.start', { sessionId: implementer.sessionId });
    return untilRound(recorder, second.id, (r) => r.status === 'ready');
  }

  const passing = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];

  it('refuses to merge until a round approves with no open blocker, then squash-merges the open PR', async () => {
    const { client, recorder, implementer, github } = await withPullRequest(passing);
    const first = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, first.id, (r) => r.status === 'ready');
    await refused(client.call('review.merge', { id: first.id }), /1 blocker still open/);

    const second = await client.call('review.start', { sessionId: implementer.sessionId });
    await untilRound(recorder, second.id, (r) => r.status === 'ready');
    await refused(client.call('review.merge', { id: first.id }), /latest round/);

    await client.call('review.merge', { id: second.id });

    expect(github.calls().some((call) => call.args.join(' ') === `pr merge 41 --squash --match-head-commit ${second.head}`)).toBe(true);
    await untilAgent(recorder, implementer.sessionId, (agent) => agent.pullRequests[0]?.state === 'merged');
  });

  it("refuses to merge while the PR's checks aren't green", async () => {
    const setup = await withPullRequest([{ __typename: 'CheckRun', name: 'check', status: 'IN_PROGRESS', conclusion: '' }]);
    const round = await approved(setup);

    await refused(setup.client.call('review.merge', { id: round.id }), /checks are pending/);
  });

  it('judges the checks as they are now, not as last seen', async () => {
    const setup = await withPullRequest(passing);
    const round = await approved(setup);
    // They fail after the daemon last looked.
    setup.setPullRequest({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }] });

    await refused(setup.client.call('review.merge', { id: round.id }), /checks are failing/);
    expect(setup.github.calls().some((call) => call.args[1] === 'merge')).toBe(false);
  });

  it("refuses to merge commits pushed after the round's reviewer looked", async () => {
    const setup = await withPullRequest(passing);
    const round = await approved(setup);
    // The implementer tidies up and pushes: the PR's head moves on from what was reviewed.
    git(setup.implementer.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-q', '-m', 'unreviewed');
    setup.setPullRequest({ headRefOid: git(setup.implementer.worktree, 'rev-parse', 'HEAD') });

    await refused(setup.client.call('review.merge', { id: round.id }), new RegExp(`at the reviewed commit ${round.head!.slice(0, 7)}: .*Head branch was modified`));
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === setup.implementer.sessionId)!.pullRequests[0]!.state).toBe('open');
  });
});
