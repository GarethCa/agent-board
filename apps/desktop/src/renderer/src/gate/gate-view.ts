// What the Gate tab (BL1) and the header's Merge show of an agent's gate. Pure, so it is unit-tested; when Open PR
// and Merge may be pressed, the clean-up's rules and what Send failure pastes are `@agent-board/daemon/gate-rules`, which
// the daemon follows too.
import type { Agent, GateCleanup, GateMerged, GateRun, GateUpdatedEvent } from '@agent-board/daemon/protocol';
import { ALL_CLEANUP, duration, shortCommit } from '@agent-board/daemon/gate-rules';

/** Whether the agent has a merge gate's controls: a worktree and branch of its own, not a folder of the user's it was resumed in. */
export const gated = (agent: Pick<Agent, 'ownsWorktree' | 'branch'>): boolean => agent.ownsWorktree && agent.branch !== '';

/** Each agent's latest run once the daemon announced a change. */
export function withGateChange(runs: ReadonlyMap<string, GateRun>, { run }: GateUpdatedEvent): Map<string, GateRun> {
  return new Map(runs).set(run.sessionId, run);
}

/** The tab's headline: `Running · 1m 48s`, `Passed: 5 of 5 · 3m 12s`, `Failed: 4 of 5 passed · 3m 5s`, `Stopped · 40s`. */
export function gateHeadline(run: GateRun, now: number): string {
  const took = duration((run.endedAt === null ? now : Date.parse(run.endedAt)) - Date.parse(run.startedAt));
  const passed = run.steps.filter((step) => step.status === 'passed').length;
  switch (run.status) {
    case 'running':
      return `Running · ${took}`;
    case 'passed':
      return `Passed: ${passed} of ${run.steps.length} · ${took}`;
    case 'failed':
      return `Failed: ${passed} of ${run.steps.length} passed · ${took}`;
    case 'stopped':
      return `Stopped · ${took}`;
  }
}

/** The tone of the run, for its tab's dot and its tile's badge. */
export function gateTone(run: GateRun): 'running' | 'passed' | 'failed' | 'idle' {
  return run.status === 'stopped' ? 'idle' : run.status;
}

/** A Gate tab's dot for the run: idle with none, or one stopped. */
export function gateDot(run: GateRun | undefined): 'gate-running' | 'gate-passed' | 'gate-failed' | 'idle' {
  const tone = run === undefined ? 'idle' : gateTone(run);
  return tone === 'idle' ? 'idle' : `gate-${tone}`;
}

/** The step whose log shows: the one picked while it is still a step of the run, else the one running, else the first failed, else the last. */
export function shownStep(run: GateRun, picked: string | undefined): string | undefined {
  if (picked !== undefined && run.steps.some((step) => step.name === picked)) return picked;
  return (run.steps.find((step) => step.status === 'running') ?? run.steps.find((step) => step.status === 'failed') ?? run.steps.at(-1))?.name;
}

/** Why the run doesn't speak for the worktree as it is now: a newer head, or changes it ran with; undefined when it does. */
export function staleNote(run: GateRun, head: string | null): string | undefined {
  if (head === null) return undefined;
  if (run.commit !== head) return `on ${shortCommit(run.commit)}, head is now ${shortCommit(head)}`;
  return run.dirty ? `on ${shortCommit(run.commit)}, with uncommitted changes` : undefined;
}

/**
 * What `gate.merge` did, in a sentence: each step done, and each that failed with why, in the popover's order. A worktree
 * and branch kept for the same reason are said once.
 */
export function mergedText(number: number, base: string, merged: GateMerged, names: { agent: string; branch: string; issue: string | undefined }): string {
  const done: Record<keyof GateCleanup, string> = {
    close: `closed ${names.agent}`,
    worktree: 'removed its worktree',
    branch: `deleted ${names.branch}`,
    comment: `commented on ${names.issue ?? 'its issue'}`,
  };
  const failed: Record<keyof GateCleanup, string> = {
    close: `couldn't close ${names.agent}`,
    worktree: 'kept its worktree',
    branch: `kept ${names.branch}`,
    comment: `couldn't comment on ${names.issue ?? 'its issue'}`,
  };
  const why = (step: keyof GateCleanup) => merged.failed.find((each) => each.step === step)?.why;
  const together = why('worktree') !== undefined && why('worktree') === why('branch');
  // In the popover's order, whatever order they ran in.
  const order = Object.keys(ALL_CLEANUP) as (keyof GateCleanup)[];
  const steps = order.flatMap((step) => {
    if (merged.done.includes(step)) return [done[step]];
    const reason = why(step);
    if (reason === undefined || (together && step === 'branch')) return [];
    if (together && step === 'worktree') return [`kept its worktree and ${names.branch} (${reason})`];
    return [`${failed[step]} (${reason})`];
  });
  return `Merged #${number} into ${base}${steps.length === 0 ? '.' : `. ${steps.join(', ').replace(/^./, (first) => first.toUpperCase())}.`}`;
}
