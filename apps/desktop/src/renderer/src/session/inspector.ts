// What the Simplified design's inspector says of an agent (SimplifiedInspector.tsx): its status line, its pull
// requests, and what its "More details" fold holds. The records are the details strip's (sidebar-records.ts).

import type { Agent, PullRequest } from '@agent-board/daemon/protocol';
import { checksLabel } from '../board/tile-footer';
import { storedValue } from '../stored-value';
import { crewSection, docSection, documentSection, pinSection, pullRequestSection, subagentSection } from './sidebar-records';

/** Whether the inspector is shown, one choice for every agent window: hidden until it is first shown. */
export const inspectorShown = storedValue('agent-board.inspector-shown');

/** Who started it, as its status line says: "you", "the Captain", the orchestrator's name, or "an agent" not listed. */
export function startedBy(agent: Pick<Agent, 'spawnedBy'>, agents: readonly Pick<Agent, 'sessionId' | 'name' | 'master'>[]): string {
  if (agent.spawnedBy === null) return 'you';
  const by = agents.find((each) => each.sessionId === agent.spawnedBy);
  if (by === undefined) return 'an agent';
  return by.master ? 'the Captain' : by.name;
}

/** The line under its status: what the status word leaves out, if anything, then who started it and when. */
export function statusLine(detail: string | null, by: string, at: string): string {
  return [detail, `started by ${by}, ${at}`].filter(Boolean).join(' · ');
}

/** A pull request row of the Work group. */
export interface PullRequestInspectorRow {
  key: string;
  url: string;
  name: string;
  /** What gh says of its checks, once it has said. */
  checks: string | undefined;
  pr: PullRequest | undefined;
}

/** Its pull requests, recorded or found, as the Work group lists them. */
export function pullRequestRows(agent: Pick<Agent, 'records' | 'pullRequests' | 'pushedPullRequests' | 'recordedPullRequests'>): PullRequestInspectorRow[] {
  return pullRequestSection(agent).rows.map(({ key, item }) => ({
    key,
    url: item.url,
    name: `Pull request #${item.number}`,
    checks: item.pr && checksLabel(item.pr),
    pr: item.pr,
  }));
}

/** How many of each thing the "More details" fold holds. */
export interface MoreDetailsCounts {
  agents: number;
  documents: number;
  pins: number;
  subagents: number;
  schedules: number;
}

/** What the fold holds: its crew, its hand-off docs and documents, its pins, its subagents and its schedule. */
export function moreDetailsCounts(agent: Agent, agents: readonly Agent[]): MoreDetailsCounts {
  return {
    agents: crewSection(agent, agents).rows.length,
    documents: docSection(agent).rows.length + documentSection(agent).length,
    pins: pinSection(agent).rows.length,
    subagents: subagentSection(agent).rows.length,
    schedules: agent.schedule === null ? 0 : 1,
  };
}

const NOUNS: Record<keyof MoreDetailsCounts, string> = { agents: 'agent', documents: 'document', pins: 'pin', subagents: 'subagent', schedules: 'schedule' };

/** "2 agents, 1 document": the fold's counts after its name, or undefined when it holds nothing and isn't drawn. */
export function moreDetailsLabel(counts: MoreDetailsCounts): string | undefined {
  const parts = (Object.keys(NOUNS) as (keyof MoreDetailsCounts)[]).filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${NOUNS[key]}${counts[key] === 1 ? '' : 's'}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}
