// What a project's heading says about its agents under the Simplified design: how many need the user, and a short count
// of the rest by status. Pure, so it is unit-tested; Board hands it to every project through the context.

import { createContext } from 'react';
import type { Agent, NeedsYouShows } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, HUMAN_STATUSES, humanStatus } from '@agent-board/daemon/human-status';

/** How many of a project's agents need the user, and the rest counted by status ("1 working · 2 done"), or "" for none. */
export interface ProjectSummary {
  needsYou: number;
  line: string;
}

/** Each project's summary, by its zone's id; a project with no agents has none. */
export function projectSummaries(agents: readonly Agent[], shows: NeedsYouShows): ReadonlyMap<string, ProjectSummary> {
  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const counts = new Map<string, Map<string, number>>();
  for (const agent of agents) {
    if (agent.zoneId === null) continue;
    const implementer = agent.reviewOf === null ? null : (byId.get(agent.reviewOf) ?? null);
    const { status } = humanStatus(agent, shows, implementer);
    const zone = counts.get(agent.zoneId) ?? new Map<string, number>();
    zone.set(status, (zone.get(status) ?? 0) + 1);
    counts.set(agent.zoneId, zone);
  }
  return new Map(
    [...counts].map(([zoneId, zone]) => [
      zoneId,
      {
        needsYou: zone.get('needs-you') ?? 0,
        line: HUMAN_STATUSES.filter((status) => status !== 'needs-you' && zone.has(status))
          .map((status) => `${zone.get(status)} ${HUMAN_STATUS_LABELS[status].toLowerCase()}`)
          .join(' · '),
      },
    ]),
  );
}

export const ProjectSummaryContext = createContext<ReadonlyMap<string, ProjectSummary>>(new Map());
