// An agent's model and role at spawn: the model goes to the harness as an argument, a role starts the agent
// with its zone's template filled in, and a reviewer works on a detached checkout of the branch it reviews.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeTracker, createMemoryCredentialStore } from '@agent-board/tracker/testing';
import { RPC_ERROR, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import type { DaemonClient } from '../src/client.ts';
import { nameSlug } from '../src/worktrees.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

async function agentDaemon() {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), idleNotifyMs: 200 }),
    credentials: createMemoryCredentialStore(),
    trackers: { linear: () => createFakeTracker() },
  });
  const client = await connectTestClient(daemon);
  return { dataDir, client, recorder: recordEvents(client) };
}

/** A repo with worker prompts, as agent-board's own has, committed. */
function repoWithPrompts(): string {
  const repo = tempRepo('storefront');
  const dir = join(repo, '.claude', 'skills', 'cmux-workers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'impl-prompt.md'), 'Implement {{ISSUE}} on {{BRANCH}} in {{WORKTREE}}.\n');
  writeFileSync(join(dir, 'review-prompt.md'), 'Review {{ISSUE}} round {{ROUND}}: {{BRANCH}} in {{WORKTREE}}, by {{IMPL_WORKTREE}}.\n');
  writeFileSync(join(dir, 'rereview-prompt.md'), 'Follow up round {{ROUND}} on {{BRANCH}}: {{PREV_REVIEW}} at {{PREV_SHA}}.\n');
  commitAll(repo, 'prompts');
  return repo;
}

function commitAll(repo: string, message: string) {
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message);
}

/** The first message the agent got, as its harness's UserPromptSubmit hook reported it. */
async function firstPrompt(recorder: ReturnType<typeof recordEvents>, sessionId: string): Promise<string> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit',
  );
  return String(event.payload.prompt);
}

async function sessionStart(recorder: ReturnType<typeof recordEvents>, sessionId: string): Promise<HookEvent> {
  return recorder.waitFor((e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'SessionStart');
}

const branches = (repo: string) => git(repo, 'branch', '--format=%(refname:short)').split('\n').sort();

async function zoneFor(client: DaemonClient, repo: string) {
  return client.call('zone.add', { path: repo, x: 0, y: 0 });
}

describe('an agent started in a role', () => {
  it('begins with its zone’s template for the role, filled in, then what was typed', async () => {
    const { client, recorder } = await agentDaemon();
    const zone = await zoneFor(client, repoWithPrompts());

    const agent = await client.call('agent.spawn', { zoneId: zone.id, role: 'implementer', prompt: 'Mind the tests', ...SIZE });

    expect(agent.role).toBe('implementer');
    expect(agent.description).toBe('Mind the tests');
    expect(await firstPrompt(recorder, agent.sessionId)).toBe(
      `Implement ${nameSlug(agent.branch)} on ${agent.branch} in ${agent.worktree}.\n\nMind the tests`,
    );
  });

  it('begins with the template the zone saved, until it is reset to the repo’s', async () => {
    const { client, recorder } = await agentDaemon();
    const zone = await zoneFor(client, repoWithPrompts());

    const saved = await client.call('zone.setRoleTemplate', { id: zone.id, role: 'implementer', body: 'Ours: {{branch}} $& {{nope}}' });
    expect(saved).toMatchObject({ role: 'implementer', body: 'Ours: {{branch}} $& {{nope}}', seed: 'impl-prompt.md', editedAt: expect.any(String) });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, role: 'implementer', ...SIZE });
    expect(await firstPrompt(recorder, agent.sessionId)).toBe(`Ours: ${agent.branch} $& {{nope}}`);

    const reset = await client.call('zone.resetRoleTemplate', { id: zone.id, role: 'implementer' });
    expect(reset).toEqual({ role: 'implementer', body: 'Implement {{issue}} on {{branch}} in {{worktree}}.\n', seed: 'impl-prompt.md', editedAt: null });
  });

  it('lists a template for every role, a custom one empty, and refuses an unknown role or zone', async () => {
    const { client } = await agentDaemon();
    const zone = await zoneFor(client, repoWithPrompts());

    const templates = await client.call('zone.roleTemplates', { id: zone.id });

    expect(templates.map((each) => [each.role, each.seed, each.editedAt])).toEqual([
      ['implementer', 'impl-prompt.md', null],
      ['reviewer', 'review-prompt.md', null],
      ['follow-up-reviewer', 'rereview-prompt.md', null],
      ['custom', null, null],
    ]);
    expect(templates.at(-1)!.body).toBe('');
    await expect(client.call('zone.setRoleTemplate', { id: zone.id, role: 'boss' as 'custom', body: 'x' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('zone.roleTemplates', { id: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('begins with the template, then the issue, then what was typed, the issue filled in by its ID', async () => {
    const { client, recorder } = await agentDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_good' });
    const zone = await zoneFor(client, repoWithPrompts());
    await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });

    const issueId = 'ACME-12';
    const agent = await client.call('agent.spawn', { zoneId: zone.id, role: 'implementer', issueId, prompt: 'And mind the tests', ...SIZE });

    const prompt = await firstPrompt(recorder, agent.sessionId);
    expect(prompt.startsWith(`Implement ${issueId} on ${agent.branch} in ${agent.worktree}.\n\n${issueId}: `)).toBe(true);
    expect(prompt.endsWith('\n\nAnd mind the tests')).toBe(true);
  });

  it('starts with only what was typed in a custom role with an empty template', async () => {
    const { client, recorder } = await agentDaemon();
    const zone = await zoneFor(client, repoWithPrompts());

    const agent = await client.call('agent.spawn', { zoneId: zone.id, role: 'custom', prompt: 'Just this', ...SIZE });

    expect(agent.role).toBe('custom');
    expect(await firstPrompt(recorder, agent.sessionId)).toBe('Just this');
  });
});

describe('a reviewer', () => {
  it('starts on a detached checkout of the branch it reviews, in a worktree of its own, with no branch', async () => {
    const { client, recorder } = await agentDaemon();
    const repo = repoWithPrompts();
    const zone = await zoneFor(client, repo);
    const implementer = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Build it', ...SIZE });
    const tip = git(repo, 'rev-parse', implementer.branch);
    const before = branches(repo);

    const reviewer = await client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch: implementer.branch, ...SIZE });

    expect(reviewer).toMatchObject({ role: 'reviewer', branch: '', reviews: { branch: implementer.branch, head: tip } });
    expect(reviewer.worktree).not.toBe(implementer.worktree);
    expect(git(reviewer.worktree, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(reviewer.worktree, 'branch', '--show-current')).toBe('');
    expect(branches(repo)).toEqual(before);
    expect(reviewer.description).toBe(`Reviews ${implementer.branch}`);
    expect(await firstPrompt(recorder, reviewer.sessionId)).toBe(
      `Review ${nameSlug(implementer.branch)} round 1: ${implementer.branch} in ${reviewer.worktree}, by ${implementer.worktree}.`,
    );
  });

  it('as a follow-up, gets the previous review, its commit and the next round', async () => {
    const { client, recorder } = await agentDaemon();
    const repo = repoWithPrompts();
    const zone = await zoneFor(client, repo);
    const implementer = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Build it', ...SIZE });
    const first = await client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch: implementer.branch, ...SIZE });
    mkdirSync(join(first.worktree, '.agent-board'), { recursive: true });
    writeFileSync(join(first.worktree, '.agent-board', 'review-STO-1.md'), 'VERDICT: changes-requested\n');

    const followUp = await client.call('agent.spawn', {
      zoneId: zone.id,
      role: 'follow-up-reviewer',
      baseBranch: implementer.branch,
      ...SIZE,
    });

    expect(followUp.worktree).not.toBe(first.worktree);
    expect(await firstPrompt(recorder, followUp.sessionId)).toBe(
      `Follow up round 2 on ${implementer.branch}: ${join(first.worktree, '.agent-board', 'review-STO-1.md')} at ${first.reviews!.head}.`,
    );
  });

  it('as a follow-up, still gets the round, the previous review and its commit once the earlier reviewer is deleted', async () => {
    const { dataDir, client, recorder } = await agentDaemon();
    const repo = repoWithPrompts();
    const zone = await zoneFor(client, repo);
    const implementer = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Build it', ...SIZE });
    const first = await client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch: implementer.branch, ...SIZE });
    mkdirSync(join(first.worktree, '.agent-board'), { recursive: true });
    writeFileSync(join(first.worktree, '.agent-board', 'review-STO-1.md'), 'VERDICT: changes-requested\n');
    await client.call('agent.delete', { sessionId: first.sessionId, force: true });
    expect(existsSync(first.worktree)).toBe(false);

    const followUp = await client.call('agent.spawn', { zoneId: zone.id, role: 'follow-up-reviewer', baseBranch: implementer.branch, ...SIZE });

    const prompt = await firstPrompt(recorder, followUp.sessionId);
    const kept = /: (\S+) at /.exec(prompt)![1]!;
    expect(prompt).toBe(`Follow up round 2 on ${implementer.branch}: ${kept} at ${first.reviews!.head}.`);
    expect(kept.startsWith(join(dataDir, 'reviews'))).toBe(true);
    expect(readFileSync(kept, 'utf8')).toBe('VERDICT: changes-requested\n');
  });

  it('refuses a branch to review that is a revision, not a branch name', async () => {
    const { client } = await agentDaemon();
    const repo = repoWithPrompts();
    const zone = await zoneFor(client, repo);
    const main = git(repo, 'branch', '--show-current');

    for (const baseBranch of [`${main}~0`, `${main}@{0}`, '-x', `../${main}`]) {
      await expect(client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch, ...SIZE })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
      });
    }
  });

  it('reviews the repo’s checked-out branch without one, takes no branch of its own, and leaves the branch when deleted', async () => {
    const { client } = await agentDaemon();
    const repo = repoWithPrompts();
    const zone = await zoneFor(client, repo);
    const main = git(repo, 'branch', '--show-current');

    await expect(client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', branch: 'mine', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/detached/),
    });
    await expect(client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch: 'nope', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    const reviewer = await client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', ...SIZE });
    expect(reviewer.reviews?.branch).toBe(main);

    await client.call('agent.delete', { sessionId: reviewer.sessionId, force: true });
    expect(branches(repo)).toContain(main);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });
});

describe('the model', () => {
  it('goes to Codex as its -m argument', async () => {
    const { client, recorder } = await agentDaemon();
    const zone = await zoneFor(client, tempRepo());

    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', model: 'gpt-5', prompt: 'Go', ...SIZE });

    expect(agent.model).toBe('gpt-5');
    expect((await sessionStart(recorder, agent.sessionId)).payload.model).toBe('gpt-5');
  });

  it('goes to Claude as its --model argument', async () => {
    const { client, recorder } = await agentDaemon();
    const zone = await zoneFor(client, tempRepo());

    const agent = await client.call('agent.spawn', { zoneId: zone.id, model: 'sonnet', prompt: 'Go', ...SIZE });

    expect((await sessionStart(recorder, agent.sessionId)).payload.model).toBe('sonnet');
  });
});
