// Resuming an external session in agent-board: what the confirmation offers, and what it warns of.
import { LIVE_ELSEWHERE_WARNING, type ExternalResumePlan } from '@agent-board/daemon/protocol';

/** Where the confirmation offers to resume: its own folder, a new worktree of its repo, or a folder the user picks. */
export type ResumeChoice = 'here' | 'new-worktree' | 'folder';


/**
 * The ways to resume it, the main one last: in its folder while that is there, else in a new worktree of its repo (in
 * git only), else in a folder the user picks.
 */
export function resumeChoices(plan: ExternalResumePlan): ResumeChoice[] {
  const worktree: ResumeChoice[] = plan.repo === null ? [] : ['new-worktree'];
  return plan.cwdExists ? [...worktree, 'here'] : ['folder', ...worktree];
}

/** What the user should know before resuming it, the gravest last. */
export function resumeWarnings(plan: ExternalResumePlan): string[] {
  const warnings: string[] = [];
  if (!plan.cwdExists) {
    warnings.push(
      plan.repo === null
        ? `${plan.cwd} is gone. Pick another folder to resume it in.`
        : `${plan.cwd} is gone. Resume it in a new worktree of its repo, or pick another folder.`,
    );
  } else if (plan.repo?.main) {
    const lands = plan.repo.branch === null ? 'its checked-out commit' : plan.repo.branch;
    warnings.push(`It will work in ${plan.cwd}, your repo's main checkout, not a worktree of its own: its changes land on ${lands} there.`);
  }
  if (plan.liveElsewhere) warnings.push(LIVE_ELSEWHERE_WARNING);
  return warnings;
}
