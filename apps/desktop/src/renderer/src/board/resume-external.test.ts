import { describe, expect, it } from 'vitest';
import { LIVE_ELSEWHERE_WARNING, type ExternalResumePlan } from '@agent-board/daemon/protocol';
import { resumeChoices, resumeWarnings } from './resume-external';

const plan = (overrides: Partial<ExternalResumePlan> = {}): ExternalResumePlan => ({
  cwd: '/code/app',
  cwdExists: true,
  repo: { root: '/code/app', worktree: '/code/app', branch: 'main', main: true },
  liveElsewhere: false,
  ...overrides,
});

describe('resuming an external session', () => {
  it('resumes in its folder, and offers a new worktree only in git', () => {
    expect(resumeChoices(plan())).toEqual(['new-worktree', 'here']);
    expect(resumeChoices(plan({ repo: null }))).toEqual(['here']);
  });

  it('offers a new worktree or another folder when its folder is gone', () => {
    expect(resumeChoices(plan({ cwdExists: false }))).toEqual(['folder', 'new-worktree']);
    expect(resumeChoices(plan({ cwdExists: false, repo: null }))).toEqual(['folder']);
  });

  it("warns that resuming here works in the user's main checkout", () => {
    expect(resumeWarnings(plan())).toEqual([
      "It will work in /code/app, your repo's main checkout, not a worktree of its own: its changes land on main there.",
    ]);
    // A linked worktree is not the main checkout; outside git there is nothing to say.
    expect(resumeWarnings(plan({ repo: { root: '/code/app', worktree: '/code/wt', branch: 'x', main: false } }))).toEqual([]);
    expect(resumeWarnings(plan({ repo: null }))).toEqual([]);
  });

  it('warns that it may still be running in another terminal', () => {
    expect(resumeWarnings(plan({ liveElsewhere: true, repo: null }))).toEqual([LIVE_ELSEWHERE_WARNING]);
  });

  it('says when its folder is gone', () => {
    expect(resumeWarnings(plan({ cwdExists: false }))).toEqual([
      '/code/app is gone. Resume it in a new worktree of its repo, or pick another folder.',
    ]);
    expect(resumeWarnings(plan({ cwdExists: false, repo: null }))).toEqual(['/code/app is gone. Pick another folder to resume it in.']);
  });
});
