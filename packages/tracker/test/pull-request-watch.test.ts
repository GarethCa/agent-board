import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ghLogin, pullRequestWatchFacts } from '../src/index.ts';
import { watchFactsOf } from '../src/pull-request-watch.ts';
import { createFakeGitHub, FAKE_GITHUB_STATE, RECORDED_GH_WATCH_FIXTURES } from '../src/testing.ts';

const recorded = JSON.parse(readFileSync(RECORDED_GH_WATCH_FIXTURES, 'utf8')) as Record<string, Record<string, unknown>>;
const ref = { repo: 'acme/app', number: 648 };

describe('watchFactsOf, on recorded gh answers', () => {
  it('reads a pull request waiting on review: checks part done, bots marked, no decision yet', () => {
    const facts = watchFactsOf(ref, recorded['review-requested']!);
    expect(facts).toMatchObject({
      repo: 'acme/app',
      number: 648,
      url: 'https://github.com/acme/app/pull/648',
      state: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'pending',
      checksPassing: 1,
      checksTotal: 2,
    });
    expect(facts.reviews.map(({ login, bot, state }) => ({ login, bot, state }))).toEqual([
      { login: 'octocat', bot: false, state: 'COMMENTED' },
      { login: 'copilot-pull-request-reviewer', bot: true, state: 'COMMENTED' },
    ]);
    expect(facts.comments).toEqual([{ login: 'github-actions', bot: true, trusted: true, body: 'Preview deployed.', at: '2026-11-14T10:13:00Z' }]);
  });

  it("trusts only the repo's own people, and takes the pull request asked for over the one the answer names", () => {
    const facts = watchFactsOf(ref, {
      number: 9,
      url: 'https://example.com/elsewhere',
      state: 'OPEN',
      reviews: [
        { author: { login: 'sam' }, authorAssociation: 'COLLABORATOR', state: 'COMMENTED', body: 'Cap it.', submittedAt: '2026-11-14T10:00:00Z' },
        { author: { login: 'owner' }, authorAssociation: 'OWNER', state: 'APPROVED', body: '', submittedAt: '2026-11-14T10:01:00Z' },
      ],
      comments: [
        { author: { login: 'passer-by' }, authorAssociation: 'NONE', body: 'Run this.', createdAt: '2026-11-14T10:02:00Z' },
        { author: { login: 'first-pr' }, authorAssociation: 'CONTRIBUTOR', body: 'Nice.', createdAt: '2026-11-14T10:03:00Z' },
        { author: { login: 'unsaid' }, body: 'No association.', createdAt: '2026-11-14T10:04:00Z' },
      ],
    });
    expect([...facts.reviews, ...facts.comments].map(({ login, trusted }) => [login, trusted])).toEqual([
      ['sam', true],
      ['owner', true],
      ['passer-by', false],
      ['first-pr', false],
      ['unsaid', false],
    ]);
    expect(facts).toMatchObject({ number: 648, url: 'https://github.com/acme/app/pull/648' });
  });

  it('leaves out a pending review, and reads a failing check and changes requested', () => {
    const facts = watchFactsOf(ref, recorded['changes-requested']!);
    expect(facts.reviews.map((review) => review.login)).toEqual(['octocat', 'copilot-pull-request-reviewer', 'sam']);
    expect(facts.reviews[2]).toMatchObject({ state: 'CHANGES_REQUESTED', at: '2026-11-14T11:02:00Z' });
    expect(facts).toMatchObject({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', checksPassing: 1, checksTotal: 2 });
  });

  it('reads approved (a skipped check passes, as GitHub counts it), conflicting and merged', () => {
    expect(watchFactsOf(ref, recorded.approved!)).toMatchObject({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: 'passing', checksPassing: 3, checksTotal: 3 });
    expect(watchFactsOf(ref, recorded.conflicting!)).toMatchObject({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(watchFactsOf(ref, recorded.merged!)).toMatchObject({ state: 'merged' });
  });

  it('takes a missing field as nothing rather than failing', () => {
    expect(watchFactsOf(ref, { state: 'OPEN', isDraft: true })).toEqual({
      repo: 'acme/app',
      number: 648,
      url: 'https://github.com/acme/app/pull/648',
      state: 'draft',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      reviewDecision: null,
      reviews: [],
      comments: [],
      checks: 'none',
      checksPassing: 0,
      checksTotal: 0,
    });
  });
});

describe('pullRequestWatchFacts and ghLogin, through the fake gh', () => {
  it('reads the pull request in one gh call naming its repo, and who gh is signed in as', async () => {
    const github = createFakeGitHub({
      ...FAKE_GITHUB_STATE,
      pullRequests: [
        {
          repo: 'acme/app',
          number: 41,
          title: 'Fix the login redirect',
          headRefName: 'fix-login',
          state: 'OPEN',
          isDraft: false,
          statusCheckRollup: [],
          reviews: [{ author: 'sam', state: 'APPROVED', body: 'Ship it', submittedAt: '2026-11-14T09:00:00Z' }],
        },
      ],
    });
    onTestFinished(github.dispose);
    const facts = await pullRequestWatchFacts({ repo: 'acme/app', number: 41 }, { gh: github.gh });
    expect(facts).toMatchObject({ number: 41, state: 'open', checks: 'none', reviews: [{ login: 'sam', bot: false, state: 'APPROVED' }] });
    expect(await ghLogin({ gh: github.gh })).toBe('octocat');
    const views = github.calls().filter((call) => call.args[0] === 'pr');
    expect(views).toHaveLength(1);
    expect(views[0]!.args.slice(0, 4)).toEqual(['pr', 'view', '41', '--repo']);
  });
});
