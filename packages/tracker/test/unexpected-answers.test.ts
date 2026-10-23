import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitHubTracker, createLinearTracker, pullRequestDetails, TrackerError } from '../src/index.ts';

/** A Linear tracker that answers every request with `data`, a 200 with whatever the test says Linear sent. */
const linearAnswering = (data: unknown) =>
  createLinearTracker({ credential: 'lin_api_x', fetch: async () => Response.json({ data }) });

const ghDirs: string[] = [];
afterAll(() => ghDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A `gh` that prints, as the real one prints JSON, the answer whose key is a substring of its arguments (the first
 * that matches), or `{}`.
 */
function ghPrinting(answers: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'unexpected-gh-'));
  ghDirs.push(dir);
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries(answers).map(([argv, out]) => `*${quote(argv)}*) printf '%s' ${quote(out)} ;;`);
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncase "$*" in\n${cases.join('\n')}\n*) printf '%s' '{}' ;;\nesac\n`);
  chmodSync(gh, 0o755);
  return gh;
}

const friendly = (kind = 'unavailable') => expect.objectContaining({ name: 'Error', kind, message: expect.stringMatching(/unexpected.*update agent-board/) });

describe('Linear answers that lack what is read', () => {
  const issueNode = { identifier: 'ACME-1', title: 'T', description: null, url: 'https://linear.app/x', state: { name: 'Todo' }, team: { key: 'ACME' }, project: null };

  it.each([
    ['no teams field', {}],
    ['teams without nodes', { teams: {} }],
    ['teams null', { teams: null }],
    ['a team without a key', { teams: { nodes: [{ name: 'Acme' }] } }],
  ])('lists teams with a friendly error for %s', async (_name, data) => {
    const error = await linearAnswering(data).scopes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrackerError);
    expect(error).toEqual(friendly());
  });

  it('gives a friendly error for projects without nodes', async () => {
    await expect(linearAnswering({ projects: {} }).projects!('ACME')).rejects.toEqual(friendly());
    await expect(linearAnswering({}).getProject!('ACME', '7c1d2e3f-0000-4000-8000-00000000000a')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for a project without a status', async () => {
    const data = { projects: { nodes: [{ id: 'p', name: 'P', description: null, progress: 0 }] } };
    await expect(linearAnswering(data).projects!('ACME')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for issue lists without nodes', async () => {
    await expect(linearAnswering({ issues: null }).listIssues('ACME')).rejects.toEqual(friendly());
    await expect(linearAnswering({}).searchIssues('ACME', 'x')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for an issue missing its team or state', async () => {
    const noTeam = { ...issueNode, team: undefined };
    const noState = { ...issueNode, state: undefined };
    await expect(linearAnswering({ issues: { nodes: [noTeam] } }).listIssues('ACME')).rejects.toEqual(friendly());
    await expect(linearAnswering({ issue: noState }).getIssue('ACME-1')).rejects.toEqual(friendly());
    await expect(linearAnswering({ issue: null }).getIssue('ACME-1')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for labels missing', async () => {
    await expect(linearAnswering({ issue: {} }).issueLabels!('ACME-1')).rejects.toEqual(friendly());
    await expect(linearAnswering({}).issueLabels!('ACME-1')).rejects.toEqual(friendly());
  });

  it('still reads a complete answer', async () => {
    await expect(linearAnswering({ issues: { nodes: [issueNode] } }).listIssues('ACME')).resolves.toMatchObject([{ id: 'ACME-1', scope: 'ACME', state: 'Todo' }]);
  });
});

describe('GitHub answers that lack what is read', () => {
  it('gives a friendly error for an issue without labels', async () => {
    const tracker = createGitHubTracker({ gh: ghPrinting({ '': '{}' }) });
    await expect(tracker.issueLabels!('acme/app#34')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for a pull request without a state', async () => {
    const tracker = createGitHubTracker({ gh: ghPrinting({ '': '{"title":"T","url":"u"}' }) });
    await expect(tracker.getPullRequest!('acme/app#34')).rejects.toEqual(friendly());
  });

  it('gives a friendly error for output that is not JSON', async () => {
    const tracker = createGitHubTracker({ gh: ghPrinting({ '': 'not json' }) });
    await expect(tracker.issueLabels!('acme/app#34')).rejects.toEqual(friendly());
  });

  describe('a pull request read', () => {
    const ref = { repo: 'acme/app', number: 41 };
    const view = JSON.stringify({
      number: 41, title: 'T', body: '', url: 'u', state: 'OPEN', isDraft: false, author: { login: 'hubot' },
      headRefName: 'h', baseRefName: 'main', headRefOid: 'abc', statusCheckRollup: [], mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviews: [], comments: [], changedFiles: 0, additions: 0, deletions: 0,
    });
    /** Every call answers sensibly except those whose argv contains a key of `broken`. */
    const reading = (broken: Record<string, string>) =>
      pullRequestDetails(ref, {
        gh: ghPrinting({
          'pr view': view,
          'pulls/41/files': '[]',
          'pulls/41/comments': '[]',
          'repo view': '{"viewerPermission":"WRITE","squashMergeAllowed":true}',
          'api user': '{"login":"octocat"}',
          ...broken,
        }),
      });

    it('works when every answer is whole', async () => {
      await expect(reading({})).resolves.toMatchObject({ number: 41, author: 'hubot' });
    });

    it.each([
      ['a view that is not an object', { 'pr view': '[]' }],
      ['comments missing', { 'pr view': view.replace('"comments":[]', '"comments":null') }],
      ['reviews missing', { 'pr view': view.replace('"reviews":[]', '"reviews":{}') }],
      ['checks that are not a list', { 'pr view': view.replace('"statusCheckRollup":[]', '"statusCheckRollup":{}') }],
      ['files that are not a list', { 'pulls/41/files': '{}' }],
      ['review comments that are not a list', { 'pulls/41/comments': '{}' }],
      ['a repo answer that is not an object', { 'repo view': '[]' }],
      ['a user answer that is not an object', { 'api user': 'null' }],
    ])('gives a friendly error for %s', async (_name, broken) => {
      await expect(reading(broken)).rejects.toEqual(friendly());
    });
  });
});
