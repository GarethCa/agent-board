// Non-makers sharing a crew's worktree, run by a real daemon on real git, its agents on the fake harness (ADR-0026):
// each writes to its own paths, the board commits them under its name at its hand-off, and a change outside them is a
// clash; the worktree is recorded for Restore, its changes keep the crew from Ready, and a maker's merge into it waits.
// Members' briefs say what they do: `Write <file>: <text>` writes it, `Stage everything` runs a stray `git add -A`,
// `Stash everything` a `git stash -u` first, and `Commit <file>: <text>` commits it, as a maker does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/protocol.ts';
import { createFakeClock } from '../fake-clock.ts';
import { git } from '../helpers.ts';
import { crewDaemon, crewWhen, type CrewSetup } from './crew-setup.ts';

const MINUTES = 60_000;

/** Saves a crew prefab of `members` along `lines` to Ready, and starts it. */
async function startCrew(setup: CrewSetup, name: string, members: object[], lines: object[]) {
  const text = JSON.stringify({
    agentBoardCrewPrefab: 2,
    name,
    icon: 'crew',
    purpose: 'Share one worktree',
    members,
    inputs: [
      { id: 'prompt', kind: 'prompt' },
      { id: 'end', kind: 'end', as: 'ready' },
    ],
    gates: [],
    lines,
  });
  await setup.client.call('orchestrator.savePrefab', { text });
  const started = await setup.client.call('orchestrator.startPrefab', { name, prompt: 'Add a footer', zoneId: setup.zone.id });
  return { crewId: started.crew!, builder: started.started[0]!.sessionId };
}

const sharer = (id: string, writes: string[], brief: string) => ({ id, role: 'designer', harness: 'claude', writes, brief });

/** The builder as the board has it now. */
async function agentOf(setup: CrewSetup, sessionId: string): Promise<Agent> {
  return (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId)!;
}

/** Each commit on `branch` after the repo's first, newest first: its author, its message and its files. */
function commitsOn(worktree: string, branch: string) {
  const root = git(worktree, 'rev-list', '--max-parents=0', branch);
  return git(worktree, 'rev-list', `${root}..${branch}`)
    .split('\n')
    .filter(Boolean)
    .map((sha) => ({
      author: git(worktree, 'log', '-1', '--format=%an', sha),
      message: git(worktree, 'log', '-1', '--format=%B', sha).trim(),
      files: git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean).sort(),
    }));
}

describe('non-makers sharing a crew worktree', () => {
  it('commits each one’s paths at its hand-off, leaves a stray `git add -A` and others’ changes out, and holds Ready for them', async () => {
    const setup = await crewDaemon();
    const { crewId, builder } = await startCrew(
      setup,
      'Spec and plan',
      [
        sharer('design', ['docs/'], 'Write docs/spec.md: the spec\nWrite plans/steps.md: steps from design\nWrite README.md: a note from design\nStage everything'),
        sharer('plan', ['plans/'], 'Write plans/more.md: more steps'),
      ],
      [
        { from: 'prompt', to: 'design' },
        { from: 'design', to: 'plan' },
        { from: 'plan', to: 'end' },
      ],
    );
    // README.md is in nobody's paths: it stays uncommitted, so the crew stops short of Ready, asking.
    await vi.waitFor(async () => expect((await agentOf(setup, builder)).flag?.reason).toMatch(/isn't ready to merge: its crew worktree has a change not committed in README\.md/), {
      timeout: 30_000,
      interval: 100,
    });
    const design = await agentOf(setup, builder);
    const plan = (await setup.client.call('agent.list')).find((each) => each.name === 'plan')!;
    // plan works in design's worktree: it owns none of its own.
    expect(plan.worktree).toBe(design.worktree);

    // The step saves the crew as it ends, after its flag.
    const crew = await crewWhen(setup.client, crewId, (each) => each.clashes?.length === 1);
    expect(crew.stopped).toBeNull();
    expect(crew.clashes).toEqual([{ path: 'README.md', by: 'design', owner: null, at: expect.any(String) }]);
    // design's commit holds its own paths alone, though its `git add -A` staged the rest; plan's names design's change.
    expect(commitsOn(design.worktree, design.branch)).toEqual([
      { author: plan.name, message: `${plan.name}: plan's work\n\nplans/steps.md has a change by design in it.`, files: ['plans/more.md', 'plans/steps.md'] },
      { author: design.name, message: `${design.name}: design's work`, files: ['docs/spec.md'] },
    ]);
    expect(git(design.worktree, 'status', '--porcelain', '--', '.', ':!.agent-board')).toBe('A  README.md');

    // The work left uncommitted is lost; Restore puts back the crew worktree's last record.
    git(design.worktree, 'reset', '--quiet', '--hard');
    expect(() => readFileSync(join(design.worktree, 'README.md'))).toThrow();
    await setup.client.call('orchestrator.crewRestore', { crewId });
    await vi.waitFor(() => expect(readFileSync(join(design.worktree, 'README.md'), 'utf8')).toBe('a note from design\n'), { timeout: 10_000 });
  }, 60_000);

  it('catches a member’s own `git stash` of others’ work at its hand-off, holds Ready for it, and Restore puts it back', async () => {
    const setup = await crewDaemon();
    const { crewId, builder } = await startCrew(
      setup,
      'Stash',
      [sharer('design', ['docs/'], 'Write docs/spec.md: the spec\nWrite plans/steps.md: steps from design'), sharer('plan', ['plans/'], 'Stash everything\nWrite plans/more.md: more steps')],
      [
        { from: 'prompt', to: 'design' },
        { from: 'design', to: 'plan' },
        { from: 'plan', to: 'end' },
      ],
    );
    // design's change in plan's paths waits for plan's hand-off, but plan's stash takes it first.
    await vi.waitFor(async () => expect((await agentOf(setup, builder)).flag?.reason).toMatch(/its crew worktree lost uncommitted work in plans\/steps\.md\. Restore puts it back/), {
      timeout: 30_000,
      interval: 100,
    });
    const design = await agentOf(setup, builder);
    expect(() => readFileSync(join(design.worktree, 'plans', 'steps.md'))).toThrow();
    expect((await crewWhen(setup.client, crewId, () => true)).stopped).toBeNull();

    await setup.client.call('orchestrator.crewRestore', { crewId });
    await vi.waitFor(() => expect(readFileSync(join(design.worktree, 'plans', 'steps.md'), 'utf8')).toBe('steps from design\n'), { timeout: 10_000 });
    // plan's own committed work stays as it is.
    expect(readFileSync(join(design.worktree, 'plans', 'more.md'), 'utf8')).toBe('more steps\n');
    expect(git(design.worktree, 'status', '--porcelain', '--', 'plans/more.md')).toBe('');
  }, 60_000);

  it('keeps two at work at once apart, each committing its own, and opens the pull request of the builder’s branch at Ready', async () => {
    const setup = await crewDaemon();
    const { crewId, builder } = await startCrew(
      setup,
      'Two at once',
      [sharer('design', ['docs/'], 'Write docs/spec.md: the spec'), sharer('ui', ['ui/'], 'Write ui/page.md: the page'), sharer('api', ['api/'], 'Write api/route.md: the route')],
      [
        { from: 'prompt', to: 'design' },
        { from: 'design', to: 'ui' },
        { from: 'design', to: 'api' },
        { from: 'ui', to: 'end' },
        { from: 'api', to: 'end' },
      ],
    );
    const ready = await crewWhen(setup.client, crewId, (crew) => crew.stopped === 'ready-to-merge');
    expect(ready.clashes ?? []).toEqual([]);
    const design = await agentOf(setup, builder);
    const commits = commitsOn(design.worktree, design.branch);
    expect(commits.map((each) => each.files).sort()).toEqual([['api/route.md'], ['docs/spec.md'], ['ui/page.md']]);
    expect(git(design.worktree, 'status', '--porcelain', '--', '.', ':!.agent-board')).toBe('');
    // Its branch is the crew's: pushed as it is, as the one pull request.
    const [pr] = setup.github.state().pullRequests;
    expect(pr!.headRefName).toBe(design.branch);
    expect(git(setup.origin, 'rev-parse', `refs/heads/${design.branch}`)).toBe(git(design.worktree, 'rev-parse', design.branch));
  }, 60_000);

  it('holds a maker’s merge on uncommitted files it touches, and asks the builder at the 30-minute limit', async () => {
    // An hour behind: the harness stamps its turns with the real time, which stays after the crew's own.
    const clock = createFakeClock(new Date(Date.now() - 60 * MINUTES));
    const setup = await crewDaemon(clock);
    const { crewId, builder } = await startCrew(
      setup,
      'Beside a maker',
      [
        sharer('design', ['docs/'], 'Write docs/spec.md: the spec\nWrite README.md: from design'),
        { id: 'impl', role: 'implementer', harness: 'claude', brief: 'Commit README.md: from impl' },
        sharer('plan', ['plans/'], 'Write plans/steps.md: the steps'),
      ],
      [
        { from: 'prompt', to: 'design' },
        { from: 'design', to: 'impl' },
        { from: 'design', to: 'plan' },
        { from: 'impl', to: 'end' },
        { from: 'plan', to: 'end' },
      ],
    );
    // It may wait on plan mid-turn first; once plan has handed off, it waits on README.md, in nobody's paths.
    const waiting = await crewWhen(setup.client, crewId, (crew) => (crew.waiting ?? []).some((each) => each.kind === 'merge' && each.missing.join() === 'the user'));
    expect(waiting.waiting).toContainEqual(expect.objectContaining({ kind: 'merge', missing: ['the user'] }));
    const design = await agentOf(setup, builder);
    // Nothing of impl's is merged over design's uncommitted README.md.
    expect(readFileSync(join(design.worktree, 'README.md'), 'utf8')).toBe('from design\n');

    clock.advance(30 * MINUTES);
    await vi.waitFor(async () => expect((await agentOf(setup, builder)).flag?.reason).toMatch(/waited 30 min to merge into its crew branch, for the user: Merge now, Wait longer \(agent-board crew round crew:\w+\), or Stop crew \(agent-board crew stop crew:\w+\)$/), {
      timeout: 15_000,
      interval: 100,
    });
    expect(readFileSync(join(design.worktree, 'README.md'), 'utf8')).toBe('from design\n');
  }, 60_000);
});
