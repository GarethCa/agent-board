import type { HumanStatus } from '@agent-board/daemon/human-status';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import type { CharacterPose } from './character-figures';

/** The pose a Classic tile's character strikes: the state its pill draws, so the two never disagree. */
export function poseOfPill(state: AgentState): CharacterPose {
  // A schedule's next run is timed as a command left running is.
  return state === 'scheduled' ? 'on-command' : state;
}

/** The pose a calm tile's character strikes: in the state that agent is in, as far as its status's word allows. */
export function poseOfStatus(status: HumanStatus, agent: Pick<Agent, 'state' | 'endedAt'>): CharacterPose {
  const { state } = agent;
  switch (status) {
    case 'needs-you':
      return state === 'stopped-by-restart' ? state : state === 'needs-permission' ? state : 'waiting';
    case 'problem':
      return 'failed';
    case 'scheduled':
      return 'on-command';
    case 'paused':
      // At its prompt with its work under review: a reviewer's implementer still works.
      return state === 'hibernated' || state === 'rate-limited' ? state : 'waiting-on-review';
    case 'done':
      return agent.endedAt === null ? 'idle' : 'done';
    case 'working':
      // A crew member at its prompt works through its orchestrator.
      return state === 'thinking' || state === 'starting' || state === 'handing-off' || state === 'on-command' ? state : 'running';
  }
}
