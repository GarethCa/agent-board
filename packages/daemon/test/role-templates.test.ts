import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillTemplate, roleSeed, type TemplateValues } from '../src/role-templates.ts';
import { tempDataDir } from './helpers.ts';

const VALUES: TemplateValues = {
  issue: 'STO-112',
  branch: 'fix-checkout-flake',
  worktree: '/wt/storefront/fix-checkout-flake-review',
  prev_review: 'none',
  round: '1',
  impl_worktree: '/wt/storefront/fix-checkout-flake',
  prev_sha: 'none',
};

describe('fillTemplate', () => {
  it('fills every variable, each time it appears', () => {
    const body = 'Review {{issue}} on {{branch}} in {{worktree}}.\nPrevious: {{prev_review}}. Again {{issue}}.';

    expect(fillTemplate(body, VALUES)).toBe(
      'Review STO-112 on fix-checkout-flake in /wt/storefront/fix-checkout-flake-review.\nPrevious: none. Again STO-112.',
    );
  });

  it('fills the seeds’ round, implementer worktree and previous commit too', () => {
    expect(fillTemplate('r{{round}} {{impl_worktree}} {{prev_sha}}', VALUES)).toBe('r1 /wt/storefront/fix-checkout-flake none');
  });

  it('puts values in as they are: a $ pattern in a path is never read as a replacement', () => {
    const body = 'In {{worktree}} on {{branch}}';

    expect(fillTemplate(body, { ...VALUES, worktree: "/wt/$&/$'x", branch: '$1' })).toBe("In /wt/$&/$'x on $1");
  });

  it('never fills a value into another: a value spelling a variable stays as it is', () => {
    expect(fillTemplate('{{branch}} {{issue}}', { ...VALUES, branch: '{{issue}}' })).toBe('{{issue}} STO-112');
  });

  it('leaves what is not one of its variables alone', () => {
    expect(fillTemplate('{{ISSUE}} {{other}} {issue} {{ issue }}', VALUES)).toBe('{{ISSUE}} {{other}} {issue} {{ issue }}');
  });
});

describe('roleSeed', () => {
  const repoWithPrompts = (files: Record<string, string>) => {
    const repo = tempDataDir();
    const dir = join(repo, '.claude', 'skills', 'cmux-workers');
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return repo;
  };

  it("takes each role's template from the repo's worker prompt, its variables written as the app's", () => {
    const repo = repoWithPrompts({
      'impl-prompt.md': 'Implement {{ISSUE}} on `{{BRANCH}}` in {{WORKTREE}}.',
      'review-prompt.md': 'Review {{ISSUE}}, round {{ROUND}}, at {{IMPL_WORKTREE}}.',
      'rereview-prompt.md': 'Previous: {{PREV_REVIEW}} at {{PREV_SHA}}. Keep {{OTHER}}.',
    });

    expect(roleSeed(repo, 'implementer')).toEqual({ body: 'Implement {{issue}} on `{{branch}}` in {{worktree}}.', source: 'impl-prompt.md' });
    expect(roleSeed(repo, 'reviewer')).toEqual({ body: 'Review {{issue}}, round {{round}}, at {{impl_worktree}}.', source: 'review-prompt.md' });
    expect(roleSeed(repo, 'follow-up-reviewer')).toEqual({
      body: 'Previous: {{prev_review}} at {{prev_sha}}. Keep {{OTHER}}.',
      source: 'rereview-prompt.md',
    });
  });

  it("falls back to the app's own template for a repo without the prompt, or no repo at all", () => {
    const repo = repoWithPrompts({ 'impl-prompt.md': 'Mine' });

    const reviewer = roleSeed(repo, 'reviewer');
    expect(reviewer.source).toBeNull();
    expect(reviewer.body).toContain('{{branch}}');
    expect(roleSeed(repo, 'follow-up-reviewer').body).toContain('{{prev_review}}');
    expect(roleSeed(null, 'implementer').source).toBeNull();
    expect(roleSeed(null, 'implementer').body).toContain('{{issue}}');
  });

  it('starts a custom role empty', () => {
    expect(roleSeed(repoWithPrompts({}), 'custom')).toEqual({ body: '', source: null });
  });
});
