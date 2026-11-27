import type { Agent } from '@agent-board/daemon/protocol';
import type { HumanStatus } from '@agent-board/daemon/human-status';

/** A button the header of an open agent shows for what it is doing now. */
export type NowActionKind = 'stop' | 'wake' | 'merge';

/**
 * What the header of an open agent offers for what it is doing now, in order: Stop while it works (never once it has
 * ended), Wake while it is paused, then a ticket's Merge once its pull request is ready (`merge`).
 */
export function nowActions(agent: Pick<Agent, 'endedAt' | 'state'>, { status, merge }: { status: HumanStatus; merge: boolean }): NowActionKind[] {
  const working = agent.endedAt === null && status === 'working';
  const state: NowActionKind[] = working ? ['stop'] : agent.state === 'hibernated' ? ['wake'] : [];
  return merge ? [...state, 'merge'] : state;
}
