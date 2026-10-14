import { describe, expect, it } from 'vitest';
import { issueBranchName, issuePrompt, type TrackerIssue } from '../src/index.ts';
import { createFakeTracker, FAKE_ISSUES } from '../src/testing.ts';
import { trackerContract } from './contract.ts';

const issue = (id: string, title: string): TrackerIssue => ({
  provider: 'linear',
  id,
  scope: id.split('-')[0]!,
  title,
  description: '',
  url: `https://linear.app/acme/issue/${id}`,
  state: 'Todo',
});

describe('issueBranchName', () => {
  it('is the lowercase issue ID and a slug of the title', () => {
    expect(issueBranchName(issue('ACME-12', 'Spawn agents in a PTY'))).toBe('acme-12-spawn-agents-in-a-pty');
  });

  it('cuts a long title at a word boundary', () => {
    const branch = issueBranchName(
      issue('ACME-7', 'Spawn a Claude agent in its own worktree with live state on its tile'),
    );
    expect(branch).toBe('acme-7-spawn-a-claude-agent-in-its-own-worktree');
    expect(branch.length).toBeLessThanOrEqual(50);
  });

  it('drops accents and punctuation, and falls back to the ID alone', () => {
    expect(issueBranchName(issue('ENG-3', 'Café: «fix» the naïve parser!'))).toBe('eng-3-cafe-fix-the-naive-parser');
    expect(issueBranchName(issue('ENG-4', '🙂 !!'))).toBe('eng-4');
  });

  it('makes a git-safe prefix of IDs such as #34', () => {
    expect(issueBranchName(issue('#34', 'Fix login'), 'gh')).toBe('gh-34-fix-login');
  });
});

describe('issuePrompt', () => {
  it('starts with the ID and title, links the issue and carries its description', () => {
    const prompt = issuePrompt({ ...issue('ACME-12', 'Spawn agents'), description: 'Use node-pty.\n\n- [ ] tests' });
    expect(prompt).toBe('ACME-12: Spawn agents\nhttps://linear.app/acme/issue/ACME-12\n\nUse node-pty.\n\n- [ ] tests');
  });

  it('leaves out an empty description', () => {
    expect(issuePrompt(issue('ACME-1', 'Spec'))).toBe('ACME-1: Spec\nhttps://linear.app/acme/issue/ACME-1');
  });
});

trackerContract('the fake tracker', () => {
  const tracker = createFakeTracker();
  return { tracker, scope: 'ACME', knownIssue: FAKE_ISSUES[0]!, searchTerm: 'keychain', inspect: tracker };
});
