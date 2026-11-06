// The unit of work an agent belongs to, as an arrange lanes it and a shelved zone stacks it: its issue, else the
// ticket its branch names, else the agents joined to it. Pure, with no Node imports, so the app's renderer reads the
// same units as the daemon.
import type { ArrangeTile } from './board-arrange.ts';
import { tileSizeKey, type Size } from './board-layout.ts';
import type { Agent } from './protocol.ts';

/** Longest slug of an agent's name in its branch name (ADR-0007). */
const MAX_SLUG_LENGTH = 40;

/** An agent's name as a slug, at most `MAX_SLUG_LENGTH`: for its branch and its scratch repo's folder. */
export function nameSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}

/** The agent `agent` reviews, among `agents`: its `reviewOf`, else the one in its zone on the branch it reviews. */
export function reviewedBy(agents: readonly Agent[], agent: Agent): Agent | undefined {
  if (agent.reviewOf !== null) return agents.find((each) => each.sessionId === agent.reviewOf);
  if (agent.reviews === null) return undefined;
  return agents.find((each) => each.zoneId === agent.zoneId && each.sessionId !== agent.sessionId && each.branch === agent.reviews!.branch);
}

/** Whether `agent`'s branch is the one agent-board named for it (`agentBranchName`), which names no ticket but its own name's. */
const namedBranch = (agent: Agent) => new RegExp(`^${nameSlug(agent.name)}-[0-9a-f]{6}$`).test(agent.branch);

/**
 * The branch whose ticket labels `agent`'s cluster: its own, or a reviewer's the one it reviews; none for a branch
 * agent-board named after its agent (`namedBranch`), whose name holds no ticket.
 */
function ticketBranch(agents: readonly Agent[], agent: Agent): string | null {
  if (agent.reviews === null) return namedBranch(agent) ? null : agent.branch;
  const reviewed = reviewedBy(agents, agent);
  return reviewed !== undefined && namedBranch(reviewed) ? null : agent.reviews.branch;
}

/**
 * `here` (agents of one zone) as an arrange and the shelves read them, among `agents` (the board's, for the ones they
 * review): `leadId` the orchestrator laying the zone out, which sits apart from every unit of work; `sizes` the tiles
 * resized, by `tileSizeKey`.
 */
export function workTilesOf(agents: readonly Agent[], here: readonly Agent[], leadId: string | undefined, sizes: Readonly<Record<string, Size>>): ArrangeTile[] {
  const branches = new Map(here.filter((agent) => agent.branch !== '').map((agent) => [agent.branch, agent.sessionId]));
  return here.map((agent): ArrangeTile => {
    // A reviewer the user started reviews `reviewOf`; one an orchestrator started reviews a branch.
    const reviewed = agent.reviewOf ?? (agent.reviews === null ? undefined : branches.get(agent.reviews.branch));
    const id = tileSizeKey('agent', agent.sessionId);
    return {
      id,
      name: agent.name,
      kind: 'agent',
      role: agent.role,
      issue: agent.issue?.id ?? null,
      issueTitle: agent.issue?.title ?? null,
      state: agent.state,
      reviewOf: reviewed === undefined ? null : tileSizeKey('agent', reviewed),
      lead: agent.sessionId === leadId,
      branch: ticketBranch(agents, agent),
      createdAt: agent.createdAt,
      ...(sizes[id] === undefined ? {} : { size: sizes[id] }),
    };
  });
}
