// What an agent is told of the user's decision on its plan: in the answer of the call that waited on it, or, for a plan
// it left (`agent-board doc --plan`), typed at its prompt later.
import { DEFAULT_PLAN_WAIT_MS, type PlanEdits, type PlanEnd, type PlanResult } from './protocol.ts';
import { toldDiff } from './text-diff.ts';

/** A wait in minutes, as a model reads it. */
export const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;

/** Where the user's approved version of a plan is now: its file, if it was written; else for the agent to apply. */
function editedFile(path: string | undefined, edits: PlanEdits): string {
  if (edits.written) return `${path} now holds their version.`;
  if (path === undefined) return 'Carry out their version, not yours.';
  return `${path} still holds yours (${edits.problem}): apply their changes to it.`;
}

/** The decision on a plan, for its agent: `plan` is the path it was read from and the wait it asked for, as it presented it. */
export function planDecisionText({ version, decision, edits }: PlanResult, plan: { path?: string; timeoutMs?: number }): string {
  const comments = decision.comments === '' ? '' : `\n\nTheir comments:\n${decision.comments}`;
  const said: Record<PlanEnd['outcome'], string> =
    edits === null
      ? {
          approved: `The user approved plan v${version}. Go ahead with it.${comments}`,
          'changes-requested': `The user asked for changes to plan v${version}.${comments}\n\nRevise the plan and present it again.`,
          rejected: `The user rejected plan v${version}. Don't carry it out.${comments}`,
          'timed-out': `No decision on plan v${version} came within ${minutes(plan.timeoutMs ?? DEFAULT_PLAN_WAIT_MS)}. Don't carry it out yet: present it again, or ask.`,
          withdrawn: `Plan v${version} was withdrawn before the user decided.`,
        }
      : {
          approved:
            `The user approved plan v${version}, their edit of your v${edits.from}. ${editedFile(plan.path, edits)}\n\n` +
            `Their changes to your v${edits.from}:\n${toldDiff(edits.diff)}\n\nGo ahead with their version.${comments}`,
          'changes-requested':
            `The user asked for changes to plan v${edits.from}, and edited it (v${version}):\n${toldDiff(edits.diff)}${comments}\n\n` +
            'Revise the plan with their changes and present it again.',
          rejected: `The user rejected plan v${version}, their edit of your v${edits.from}. Don't carry it out.${comments}`,
          'timed-out': `No decision on plan v${version}, the user's edit of your v${edits.from}, came within ${minutes(plan.timeoutMs ?? DEFAULT_PLAN_WAIT_MS)}. Don't carry it out yet: present it again, or ask.`,
          withdrawn: `Plan v${version}, the user's edit of your v${edits.from}, was withdrawn before the user decided.`,
        };
  return said[decision.outcome];
}
