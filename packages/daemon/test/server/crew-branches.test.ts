// A crew of two makers run by a real daemon, its agents on the fake harness and GitHub a fake `gh` (ADR-0026): its
// crew branch is cut from the builder's, the second maker's branch from it, and its Ready end pushes the crew branch
// and opens one draft pull request of it, recorded on the builder, whose merge closes the crew and its crew worktree.
// Makers whose briefs say `Commit <file>: <text>` commit that file on their branch: the crew merges them, or a
// conflict between them goes back.
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import type { Crew } from '../../src/protocol.ts';
import { connectTestClient, git, startTestDaemon, tempDataDir } from '../helpers.ts';
import { crewDaemon, crewWhen, repoWithOrigin, type CrewSetup } from './crew-setup.ts';

/** A builder whose hand-off goes to two makers side by side, each committing `file` with its own text, that meet at Ready. */
async function sideBySide(setup: CrewSetup, files: { api: string; ui: string }) {
  const text = JSON.stringify({
    agentBoardCrewPrefab: 2,
    name: 'Side by side',
    icon: 'crew',
    purpose: 'Build it in two halves at once',
    members: [
      { id: 'impl', role: 'implementer', harness: 'claude' },
      { id: 'api', role: 'implementer', harness: 'claude', brief: `Commit ${files.api}: export const api = 1;` },
      { id: 'ui', role: 'implementer', harness: 'claude', brief: `Commit ${files.ui}: export const ui = 1;` },
    ],
    inputs: [
      { id: 'prompt', kind: 'prompt' },
      { id: 'end', kind: 'end', as: 'ready' },
    ],
    gates: [],
    lines: [
      { from: 'prompt', to: 'impl' },
      { from: 'impl', to: 'api', carries: 'handoff' },
      { from: 'impl', to: 'ui', carries: 'handoff' },
      { from: 'api', to: 'end' },
      { from: 'ui', to: 'end' },
    ],
  });
  await setup.client.call('orchestrator.savePrefab', { text });
  const started = await setup.client.call('orchestrator.startPrefab', { name: 'Side by side', prompt: 'Add a footer', zoneId: setup.zone.id });
  return started.crew!;
}

describe('two makers side by side', () => {
  it("merge into the crew branch with merge commits, its pull request's head holding both makers' work", async () => {
    const setup = await crewDaemon();
    const crewId = await sideBySide(setup, { api: 'api.ts', ui: 'ui.ts' });
    await crewWhen(setup.client, crewId, (crew) => crew.stopped === 'ready-to-merge');
    const [pr] = setup.github.state().pullRequests;
    const head = pr!.headRefName;
    // Pushed as the crew branch is: its tip a merge of a maker's branch, with both files.
    expect(git(setup.origin, 'rev-parse', `refs/heads/${head}`)).toBe(git(setup.repo, 'rev-parse', head));
    expect(git(setup.repo, 'rev-list', '--parents', '-n', '1', head).split(' ')).toHaveLength(3);
    expect(git(setup.repo, 'show', `${head}:api.ts`)).toBe('export const api = 1;');
    expect(git(setup.repo, 'show', `${head}:ui.ts`)).toBe('export const ui = 1;');
  });

  it('that conflict send it back to the maker, stop at the second running, and send it again at crew round', async () => {
    const setup = await crewDaemon();
    const crewId = await sideBySide(setup, { api: 'shared.ts', ui: 'shared.ts' });
    const crew = await crewWhen(setup.client, crewId, (each) => each.stopped === 'round-limit');
    const flagOf = async () => (await setup.client.call('agent.list')).find((each) => each.sessionId === crew.builder)!.flag?.reason ?? '';
    // Sent back once, handed off again with nothing merged, and conflicting again: the crew stops, asking.
    expect(await flagOf()).toMatch(/stopped: (api|ui)'s branch conflicted with its crew branch twice running, in shared\.ts: agent-board crew round crew:\S+ for one more try/);
    expect(setup.github.state().pullRequests).toEqual([]);
    // Never left mid-merge.
    const worktrees = git(setup.repo, 'worktree', 'list', '--porcelain');
    const crewWorktree = [...worktrees.matchAll(/worktree (.*)\n[^\n]*\nbranch refs\/heads\/(.*-crew)\n/g)].map((match) => match[1]!)[0]!;
    expect(git(crewWorktree, 'status', '--porcelain')).toBe('');

    // One more try: sent back, it hands off and conflicts again, and the crew stops again.
    await setup.client.call('orchestrator.crewRound', { crewId });
    await crewWhen(setup.client, crewId, (each) => each.stopped === 'round-limit' && each.stoppedAt !== crew.stoppedAt);
    expect(git(crewWorktree, 'status', '--porcelain')).toBe('');
  }, 90_000);
});

describe('a crew of two makers', () => {
  it('cuts its crew branch, the second maker from it, and opens one draft pull request of it at Ready', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web', description: null }] });
    const { repo, origin } = repoWithOrigin();
    const daemon = await startTestDaemon({
      dataDir: tempDataDir(),
      worktreesDir: tempDataDir(),
      gh: github.gh,
      pullRequestPollMs: 100,
      agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
    });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
    const text = JSON.stringify({
      agentBoardCrewPrefab: 2,
      name: 'Two makers',
      icon: 'crew',
      purpose: 'Build it in two halves',
      members: [
        { id: 'api', role: 'implementer', harness: 'claude', brief: 'Commit api.ts: export const api = 1;' },
        { id: 'ui', role: 'implementer', harness: 'claude', brief: 'Commit ui.ts: export const ui = 1;' },
      ],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'api' },
        { from: 'api', to: 'ui', carries: 'handoff' },
        { from: 'ui', to: 'end' },
      ],
    });
    await client.call('orchestrator.savePrefab', { text });
    const started = await client.call('orchestrator.startPrefab', { name: 'Two makers', prompt: 'Add a footer', zoneId: zone.id });
    const api = started.started[0]!;

    const ready = await vi.waitFor(
      async () => {
        const [crew] = await client.call('orchestrator.crews', { crewId: started.crew! });
        if (crew?.stopped !== 'ready-to-merge') throw new Error(`not ready yet: ${JSON.stringify(crew)}`);
        return crew as Crew;
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(ready.stopped).toBe('ready-to-merge');

    const agents = await client.call('agent.list');
    const builder = agents.find((each) => each.sessionId === api.sessionId)!;
    const ui = agents.find((each) => each.name === 'ui')!;
    const [pr] = github.state().pullRequests;
    const crewBranch = pr!.headRefName;
    // The crew branch is cut from the builder's, and ui's own branch from the crew branch: none of them the same.
    expect(crewBranch).toBe(`${builder.branch}-crew`);
    expect(new Set([builder.branch, ui.branch, crewBranch]).size).toBe(3);
    // Cut from it as it was once api's work was merged in: the crew branch's tip merges ui's on top of that.
    expect(git(repo, 'merge-base', '--is-ancestor', `${crewBranch}^1`, ui.branch)).toBe('');
    // api's work was merged into the crew branch before ui started from it, and ui's at Ready, each with a merge commit.
    expect(git(repo, 'show', `${ui.branch}:api.ts`)).toBe('export const api = 1;');
    expect(git(repo, 'log', '--merges', '--format=%s', crewBranch).split('\n')).toEqual([`Merge ${ui.branch} into the crew branch`, `Merge ${builder.branch} into the crew branch`]);
    // Pushed, never forced, and opened once, as a draft, recorded on the builder.
    expect(git(origin, 'rev-parse', `refs/heads/${crewBranch}`)).toBe(git(repo, 'rev-parse', crewBranch));
    expect(github.state().pullRequests).toHaveLength(1);
    expect(pr).toMatchObject({ repo: 'acme/web', title: `Two makers crew: ${crewBranch}`, isDraft: true });
    expect(pr!.body).toContain(`- ui: \`${ui.branch}\``);
    await vi.waitFor(async () => {
      const [now] = (await client.call('agent.list')).filter((each) => each.sessionId === api.sessionId);
      expect(now!.recordedPullRequests.map((each) => each.url)).toContain(`https://github.com/acme/web/pull/${pr!.number}`);
    });
    // Its crew worktree stays until the crew closes.
    const worktrees = git(repo, 'worktree', 'list', '--porcelain');
    expect(worktrees).toContain(`branch refs/heads/${crewBranch}`);
    const crewWorktree = /worktree (.*)\n[^\n]*\nbranch refs\/heads\/(.*)/g;
    const paths = [...worktrees.matchAll(crewWorktree)].filter((match) => match[2] === crewBranch).map((match) => match[1]!);
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(true);

    // Its pull request merged: the crew closes its agents, and its crew worktree and branch go with them.
    const state = github.state();
    github.setState({ ...state, pullRequests: state.pullRequests.map((each) => ({ ...each, state: 'MERGED' as const })) });
    await vi.waitFor(
      async () => {
        const [crew] = await client.call('orchestrator.crews', { crewId: started.crew! });
        if (crew?.stopped !== 'merged') throw new Error(`not merged yet: ${crew?.stopped}`);
      },
      { timeout: 30_000, interval: 100 },
    );
    await vi.waitFor(
      () => {
        expect(existsSync(paths[0]!)).toBe(false);
        expect(git(repo, 'branch', '--list', crewBranch)).toBe('');
      },
      { timeout: 10_000 },
    );
  });
});
