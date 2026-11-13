// Claude's plan approval as the board shows it (P1): the plan's title and first lines, and Claude's own choices
// in its words, each mapped to the decision its held hook takes. Its other choices (clear the context first, bypass
// permissions) can't go through the hook, so they stay in its terminal.
import type { PermissionDecision } from '@agent-board/daemon/protocol';

/** How many lines of the plan show under its title before Read the plan. */
const PLAN_GLIMPSE_LINES = 3;

const plainLine = (line: string) => line.replace(/^#+\s*/, '').trim();

/** The plan's title: its first heading, else its first line; '' for an empty plan. */
export function planTitle(plan: string): string {
  const lines = plan.split('\n').filter((line) => line.trim() !== '');
  const heading = lines.find((line) => /^#+\s/.test(line.trim()));
  return plainLine(heading ?? lines[0] ?? '');
}

/** The plan's first `PLAN_GLIMPSE_LINES` lines after its title, as Markdown, with "…" where there is more. */
export function planGlimpse(plan: string): string {
  const lines = plan.split('\n').filter((line) => line.trim() !== '');
  const title = planTitle(plan);
  const at = lines.findIndex((line) => plainLine(line) === title);
  const rest = lines.slice(at + 1);
  const shown = rest.slice(0, PLAN_GLIMPSE_LINES);
  return rest.length > PLAN_GLIMPSE_LINES ? `${shown.join('\n')}…` : shown.join('\n');
}

/** One of Claude's choices on its plan, in its words, and what the board answers its hook with. */
export interface PlanChoice {
  label: string;
  decision: PermissionDecision;
  /** Claude's own default, drawn as the primary. */
  primary: boolean;
}

/**
 * Claude's choices the hook can give, in its dialog's order: Yes, auto-accept edits, then Yes, approve each edit. Both
 * are offered whatever Claude suggested, as the daemon's reply sets the mode each goes on in (`planReply`). No, keep
 * planning is drawn on its own, as it takes what to change.
 */
export const PLAN_CHOICES: readonly PlanChoice[] = [
  { label: 'Yes, auto-accept edits', decision: { behavior: 'allow', scope: 'session' }, primary: true },
  { label: 'Yes, approve each edit', decision: { behavior: 'allow' }, primary: false },
];

/** No, keep planning: a deny that carries what to change, if the user said. */
export function keepPlanning(words: string): PermissionDecision {
  const message = words.trim();
  return message === '' ? { behavior: 'deny' } : { behavior: 'deny', message };
}
