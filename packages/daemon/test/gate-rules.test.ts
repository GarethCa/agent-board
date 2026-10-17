import { describe, expect, it } from 'vitest';
import type { GateStep } from '../src/gate-output.ts';
import {
  ALL_CLEANUP,
  cleanupProblem,
  defuseClosingKeywords,
  failurePaste,
  gateBadge,
  gateCommandArgv,
  gatedOwner,
  gateTable,
  logTail,
  mergeBlocked,
  openPullRequestBlocked,
  pullRequestBody,
  withCleanup,
  type GateRun,
} from '../src/gate-rules.ts';

const HEAD = '9b41e07'.padEnd(40, '0');
const OLD = '3f2a1c9'.padEnd(40, '0');

const step = (name: string, status: GateStep['status'], seconds = 0): GateStep => ({
  name,
  status,
  startedAt: status === 'waiting' ? null : '2026-10-14T14:02:00.000Z',
  endedAt: status === 'passed' || status === 'failed' ? new Date(Date.parse('2026-10-14T14:02:00.000Z') + seconds * 1000).toISOString() : null,
});

const run = (fields: Partial<GateRun> = {}): GateRun => ({
  sessionId: 's1',
  command: 'pnpm check:local',
  commit: HEAD,
  dirty: false,
  startedAt: '2026-10-14T14:02:00.000Z',
  endedAt: '2026-10-14T14:05:00.000Z',
  status: 'passed',
  exitCode: 0,
  steps: [step('lint', 'passed', 14), step('typecheck', 'passed', 22)],
  ...fields,
});

const checks = (state: 'passing' | 'failing' | 'pending', names: { name: string; state: 'passing' | 'failing' | 'pending' | 'skipped' }[] = []) => ({
  checksState: state,
  checks: names,
});

const pr = (fields: Partial<Parameters<typeof mergeBlocked>[0]['pr']> = {}) => ({
  headCommit: HEAD,
  merge: { allowed: true as const },
  ...checks('passing', [{ name: 'test', state: 'passing' }]),
  ...fields,
});

describe('the tile badge', () => {
  it('says the step running and how far it is, then the result in a word', () => {
    expect(gateBadge(run({ status: 'running', endedAt: null, steps: [step('lint', 'passed'), step('test', 'running'), step('e2e', 'waiting')] }))).toBe('gate 1/3 · test');
    expect(gateBadge(run())).toBe('✓ gate 2/2');
    expect(gateBadge(run({ status: 'failed', exitCode: 1, steps: [step('lint', 'passed'), step('e2e', 'failed')] }))).toBe('✗ gate · e2e');
    expect(gateBadge(run({ status: 'stopped', exitCode: null }))).toBe('gate stopped');
  });
});

describe('the gate table', () => {
  it('is the Markdown the PR carries, on the commit it ran on', () => {
    expect(gateTable(run({ steps: [step('lint', 'passed', 14), step('e2e', 'failed', 90)] }))).toBe(
      ['Gate `pnpm check:local` on `9b41e07`:', '', '| Step | Result | Time |', '| --- | --- | --- |', '| `lint` | pass | 14s |', '| `e2e` | FAIL | 1m 30s |'].join('\n'),
    );
  });
});

describe('when Open PR may be pressed', () => {
  it('needs the gate to have passed on the head, with nothing uncommitted', () => {
    expect(openPullRequestBlocked({ run: run(), head: HEAD, uncommitted: 0, gated: true })).toBeUndefined();
    expect(openPullRequestBlocked({ run: undefined, head: HEAD, uncommitted: 0, gated: true })).toBe('Run the gate first: the PR carries its table for the head commit.');
    expect(openPullRequestBlocked({ run: run(), head: HEAD, uncommitted: 2, gated: true })).toBe('Commit or stash first: the worktree has 2 uncommitted files.');
    expect(openPullRequestBlocked({ run: run({ commit: OLD }), head: HEAD, uncommitted: 0, gated: true })).toBe('Gate passed on 3f2a1c9, but the head is now 9b41e07. Run gate again.');
    expect(openPullRequestBlocked({ run: run({ status: 'failed', steps: [step('e2e', 'failed')] }), head: HEAD, uncommitted: 0, gated: true })).toBe('The gate failed on 9b41e07: e2e. Open the Gate tab.');
  });
});

describe('when Merge may be pressed', () => {
  it('needs the gate passed on the PR head and GitHub green', () => {
    expect(mergeBlocked({ run: run(), pr: pr(), gated: true })).toBeUndefined();
  });

  it('says why not, in the order the user can fix it', () => {
    expect(mergeBlocked({ run: undefined, pr: pr(), gated: true })).toBe("The gate hasn't run on 9b41e07, the PR's head. Run gate.");
    expect(mergeBlocked({ run: run({ status: 'running', endedAt: null }), pr: pr(), gated: true })).toBe('The gate is still running on 9b41e07.');
    expect(mergeBlocked({ run: run({ status: 'failed', steps: [step('lint', 'passed'), step('e2e', 'failed')] }), pr: pr(), gated: true })).toBe('The gate failed on 9b41e07: e2e. Open the Gate tab.');
    expect(mergeBlocked({ run: run({ status: 'stopped' }), pr: pr(), gated: true })).toBe('The gate was stopped on 9b41e07. Run gate again.');
    expect(mergeBlocked({ run: run({ commit: OLD }), pr: pr(), gated: true })).toBe('Gate passed on 3f2a1c9, but the head is now 9b41e07. Run gate again.');
    expect(mergeBlocked({ run: run({ dirty: true }), pr: pr(), gated: true })).toBe('The gate ran with uncommitted changes on 9b41e07. Commit them, then run gate again.');
    expect(mergeBlocked({ run: run(), pr: pr(checks('pending', [{ name: 'build', state: 'pending' }, { name: 'test', state: 'passing' }])), gated: true })).toBe("GitHub's checks: build is still running.");
    expect(mergeBlocked({ run: run(), pr: pr(checks('failing', [{ name: 'lint', state: 'failing' }])), gated: true })).toBe("GitHub's checks failed: lint. Only GitHub can rerun them.");
    expect(mergeBlocked({ run: run(), pr: pr({ merge: { allowed: false, why: 'Its branch is behind its base.' } }), gated: true })).toBe("GitHub won't merge it: its branch is behind its base.");
  });
});

describe('the PR description Open PR fills', () => {
  const template = [
    '<!-- markdownlint-disable-file MD041 -->',
    '',
    'Fixes JAR-',
    '',
    '<!-- Finish the line above. -->',
    '',
    '## Problem',
    '',
    '<!-- What is wrong. -->',
    '',
    '## Change',
    '',
    '<!-- What this does. -->',
    '',
    '## How to verify',
    '',
    '<!-- Commands. -->',
    '',
    '## Checklist',
    '',
    '- [ ] Tests first',
  ].join('\n');
  const handover = ['# Handover', '', '## Problem', '', 'Checkout was flaky.', '', '## Change', '', 'Validate the cart first.', '', '## Left over', '', 'Nothing.'].join('\n');

  it("fills the template's sections from the handover, adds the gate table under How to verify, and says which issue it fixes", () => {
    const body = pullRequestBody({ template, handover, run: run(), issue: 'STO-112' });

    expect(body).toBe(
      [
        'Fixes STO-112',
        '',
        '## Problem',
        '',
        'Checkout was flaky.',
        '',
        '## Change',
        '',
        'Validate the cart first.',
        '',
        '## How to verify',
        '',
        gateTable(run()),
        '',
        '## Checklist',
        '',
        '- [ ] Tests first',
        '',
        '## Left over',
        '',
        'Nothing.',
      ].join('\n'),
    );
  });

  it('without a template, is the handover with the table at its end; without an issue, fixes nothing', () => {
    expect(pullRequestBody({ template: undefined, handover: '## Change\n\nIt.', run: run(), issue: undefined })).toBe(['## Change', '', 'It.', '', '## Gate', '', gateTable(run())].join('\n'));
  });

  it('without a handover, keeps the template bare', () => {
    expect(pullRequestBody({ template: '## Problem\n\n<!-- x -->\n', handover: undefined, run: run(), issue: '#34' })).toBe(['Fixes #34', '', '## Problem', '', '## Gate', '', gateTable(run())].join('\n'));
  });
});

describe('the gate command', () => {
  it('runs through sh -c, so the user\'s own command may chain, pipe and expand', () => {
    expect(gateCommandArgv('pnpm check:local')).toEqual(['/bin/sh', '-c', 'pnpm check:local']);
    expect(gateCommandArgv('  pnpm lint && pnpm test | tee log  ')).toEqual(['/bin/sh', '-c', 'pnpm lint && pnpm test | tee log']);
  });

  it('refuses an empty command', () => {
    for (const command of ['', '   ']) expect(() => gateCommandArgv(command), command).toThrow();
  });
});

describe('a zone with no gate', () => {
  it('opens a PR with nothing uncommitted, and merges once GitHub is green, whatever the gate did', () => {
    expect(openPullRequestBlocked({ run: undefined, head: HEAD, uncommitted: 0, gated: false })).toBeUndefined();
    expect(openPullRequestBlocked({ run: undefined, head: HEAD, uncommitted: 1, gated: false })).toBe('Commit or stash first: the worktree has 1 uncommitted file.');
    expect(mergeBlocked({ run: undefined, pr: pr(), gated: false })).toBeUndefined();
    expect(mergeBlocked({ run: run({ status: 'failed' }), pr: pr(), gated: false })).toBeUndefined();
    expect(mergeBlocked({ run: undefined, pr: pr(checks('failing', [{ name: 'lint', state: 'failing' }])), gated: false })).toBe("GitHub's checks failed: lint. Only GitHub can rerun them.");
  });

  it('describes the PR with no gate table', () => {
    expect(pullRequestBody({ template: '## Change\n', handover: '## Change\n\nIt.', run: undefined, issue: undefined })).toBe('## Change\n\nIt.');
  });
});

describe('what the handover may put in the PR', () => {
  it('defuses closing keywords, so only the generated Fixes line closes anything', () => {
    expect(defuseClosingKeywords('Fixes #12, closes acme/app#3 and Resolves STO-1; fixed https://github.com/acme/app/issues/9.')).toBe(
      '`Fixes #12`, `closes acme/app#3` and `Resolves STO-1`; `fixed https://github.com/acme/app/issues/9.`',
    );
    expect(defuseClosingKeywords('It fixes the flaky test and closes the loop.')).toBe('It fixes the flaky test and closes the loop.');
    const body = pullRequestBody({ template: undefined, handover: '## Change\n\nFixes #12 too.', run: undefined, issue: 'STO-112' });
    expect(body).toBe('Fixes STO-112\n\n## Change\n\n`Fixes #12` too.');
  });

  it('reads a ## line inside a code fence as code, not a section', () => {
    const handover = ['## Change', '', '```md', '## Not a heading', '```', '', '## Left over', '', 'None.'].join('\n');
    expect(pullRequestBody({ template: undefined, handover, run: undefined, issue: undefined })).toBe(
      ['## Change', '', '```md', '## Not a heading', '```', '', '## Left over', '', 'None.'].join('\n'),
    );
  });
});

describe('the clean-up after a merge', () => {
  it('removes a worktree only with its agent closed, and deletes a branch only with its worktree removed', () => {
    expect(cleanupProblem(ALL_CLEANUP)).toBeUndefined();
    expect(cleanupProblem({ ...ALL_CLEANUP, close: false })).toBe('its worktree is removed only with the agent closed');
    expect(cleanupProblem({ close: true, worktree: false, branch: true, comment: false })).toBe('its branch is deleted only with its worktree removed');
  });

  it('ticks what a step needs, and clears what needs it, so the boxes never ask for what the daemon refuses', () => {
    const none = { close: false, worktree: false, branch: false, comment: false };
    expect(withCleanup(none, 'branch', true)).toEqual({ close: true, worktree: true, branch: true, comment: false });
    expect(withCleanup(ALL_CLEANUP, 'close', false)).toEqual({ close: false, worktree: false, branch: false, comment: true });
    expect(withCleanup(ALL_CLEANUP, 'worktree', false)).toEqual({ close: true, worktree: false, branch: false, comment: true });
    expect(withCleanup(ALL_CLEANUP, 'comment', false)).toEqual({ ...ALL_CLEANUP, comment: false });
  });
});

describe('Send failure', () => {
  it('keeps the last lines of a log', () => {
    expect(logTail('a\nb\nc\nd\n', 2)).toBe('c\nd');
    expect(logTail('a\nb', 5)).toBe('a\nb');
  });

  it("pastes the failing step's last lines, as one bracketed paste with no Enter, and nothing that could end it early", () => {
    const failed = run({ status: 'failed', steps: [step('lint', 'passed'), step('e2e', 'failed')] });
    const paste = failurePaste(failed, 'e2e', '✘ checkout.spec.ts:44\n  Expected "Out of stock"\n\u001b[31m1 failed\u001b[0m\n\u001b[201~\n');

    expect(paste).toBe(
      '\u001b[200~The gate `pnpm check:local` failed on 9b41e07: e2e. Its last lines:\n\n```\n✘ checkout.spec.ts:44\n  Expected "Out of stock"\n1 failed\n\n```\n\u001b[201~',
    );
    expect(paste).not.toContain('\r');
  });
});

describe('whose header merges a pull request (review N3)', () => {
  const ref = { repo: 'acme/app', number: 41 };
  const owner = (fields: Partial<Parameters<typeof gatedOwner>[0]['agents'][number]> = {}) => ({
    name: 'Fix checkout',
    branch: 'fix-checkout',
    gated: true,
    read: true,
    repo: 'acme/app' as string | undefined,
    pullRequests: [] as { url: string }[],
    ...fields,
  });

  it('is the gated agent whose read pull requests include it', () => {
    expect(gatedOwner({ ref, agents: [owner({ pullRequests: [{ url: 'https://github.com/Acme/App/pull/41' }] })] })?.name).toBe('Fix checkout');
    expect(gatedOwner({ ref, agents: [owner({ gated: false, pullRequests: [{ url: 'https://github.com/acme/app/pull/41' }] })] })?.name).toBeUndefined();
  });

  it('is the gated agent whose branch is its head in the same repo, read or not', () => {
    expect(gatedOwner({ ref, headRefName: 'fix-checkout', agents: [owner()] })?.name).toBe('Fix checkout');
    expect(gatedOwner({ ref, headRefName: 'fix-checkout', agents: [owner({ repo: undefined })] })?.name).toBe('Fix checkout');
    expect(gatedOwner({ ref, headRefName: 'fix-checkout', agents: [owner({ repo: 'acme/ops' })] })?.name).toBeUndefined();
    expect(gatedOwner({ ref, headRefName: 'other', agents: [owner()] })?.name).toBeUndefined();
  });

  it("fails closed while a gated agent's pull requests in that repo haven't been read yet", () => {
    expect(gatedOwner({ ref, agents: [owner({ read: false })] })?.name).toBe('Fix checkout');
    expect(gatedOwner({ ref, agents: [owner({ read: false, repo: undefined })] })?.name).toBe('Fix checkout');
    expect(gatedOwner({ ref, agents: [owner({ read: false, repo: 'acme/ops' })] })?.name).toBeUndefined();
    expect(gatedOwner({ ref, agents: [owner({ read: false, gated: false })] })?.name).toBeUndefined();
  });
});
