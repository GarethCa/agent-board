// The Activity tab's lines (BB1): what an orchestrator did and tried, and the hand-offs of any agent, from the daemon's activity log. Pure, so
// the wording is unit-tested.
import { DEFAULT_ACTIVITY_LIMIT, type OrchestratorAction, type OrchestratorActivity } from '@agent-board/daemon/protocol';

/** Each action's verb, as done and as tried. */
const VERBS: Record<OrchestratorAction, { done: string; tried: string }> = {
  spawn: { done: 'started', tried: 'start' },
  send: { done: 'sent', tried: 'send' },
  interrupt: { done: 'interrupted', tried: 'interrupt' },
  close: { done: 'closed', tried: 'close' },
  remove: { done: 'removed', tried: 'remove' },
  'add-edge': { done: 'added an edge into', tried: 'add an edge into' },
  'remove-edge': { done: 'removed an edge into', tried: 'remove an edge into' },
  handoff: { done: 'handed off to', tried: 'hand off to' },
};

/** What the line says it did to whom ("started web impl"), or tried to ("tried to close …"). */
export function activityText(entry: OrchestratorActivity): string {
  const verb = VERBS[entry.action];
  const target = entry.targetName ?? 'an agent';
  return entry.outcome === 'done' ? `${verb.done} ${target}` : `tried to ${verb.tried} ${target}`;
}

/** `lines` (newest first) with `logged` first if it is a new line of `orchestratorId`'s; else `lines` itself. */
export function withLogged(
  lines: readonly OrchestratorActivity[],
  orchestratorId: string,
  logged: OrchestratorActivity,
): readonly OrchestratorActivity[] {
  if (logged.orchestratorId !== orchestratorId || lines.some((line) => line.id === logged.id)) return lines;
  return [logged, ...lines];
}

/** `lines` (newest first) with `page`, a page of older lines, after them: each once. */
export function withOlder(lines: readonly OrchestratorActivity[], page: readonly OrchestratorActivity[]): readonly OrchestratorActivity[] {
  const known = new Set(lines.map((line) => line.id));
  return [...lines, ...page.filter((line) => !known.has(line.id))];
}

/** Whether a page that came back with `count` lines may have more after it: it was full. */
export const mayHaveOlder = (count: number): boolean => count >= DEFAULT_ACTIVITY_LIMIT;
