// What an agent's sidebar (SimplifiedInspector.tsx) says of an agent: who started it, and its pull requests as Made
// lists them for now. The records are the details strip's (sidebar-records.ts).

import type { Agent, PullRequest } from '@agent-board/daemon/protocol';
import { checksLabel } from '../board/tile-footer';
import { storedValue } from '../stored-value';
import { pullRequestSection } from './sidebar-records';

/** Whether the inspector is shown, one choice for every agent window: hidden until it is first shown. */
export const inspectorShown = storedValue('agent-board.inspector-shown');

/** Who started it, as the page's Now says: "you", "the Captain", the orchestrator's name, or "an agent" not listed. */
export function startedBy(agent: Pick<Agent, 'spawnedBy'>, agents: readonly Pick<Agent, 'sessionId' | 'name' | 'master'>[]): string {
  if (agent.spawnedBy === null) return 'you';
  const by = agents.find((each) => each.sessionId === agent.spawnedBy);
  if (by === undefined) return 'an agent';
  return by.master ? 'the Captain' : by.name;
}

/** The page's status line: what the status word leaves out, if anything, then who started it and when. */
export function statusLine(detail: string | null, by: string, at: string): string {
  return [detail, `started by ${by}, ${at}`].filter(Boolean).join(' · ');
}

/** A pull request row of Made. */
export interface PullRequestInspectorRow {
  key: string;
  url: string;
  name: string;
  /** What gh says of its checks, once it has said. */
  checks: string | undefined;
  pr: PullRequest | undefined;
}

/** Its pull requests, recorded or found, as Made lists them. */
export function pullRequestRows(agent: Pick<Agent, 'records' | 'pullRequests' | 'pushedPullRequests' | 'recordedPullRequests'>): PullRequestInspectorRow[] {
  return pullRequestSection(agent).rows.map(({ key, item }) => ({
    key,
    url: item.url,
    name: `Pull request #${item.number}`,
    checks: item.pr && checksLabel(item.pr),
    pr: item.pr,
  }));
}
