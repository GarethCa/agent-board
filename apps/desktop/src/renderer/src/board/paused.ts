// Pausing an agent (hibernating it) from its tile and window, and what a paused tile says. Pure, so the rules are
// unit-tested. Only the user or an orchestrator pauses an agent: nothing here suggests it.
import { pauseRefusal, type Agent } from '@agent-board/daemon/protocol';
import { sinceText } from '../../../shared/needs-you';
import { upperFirst } from '../upper-first';

/** What Pause does, as its hint while it can. */
export const PAUSE_HINT = 'Hibernate it to free its memory: Wake, or a message, starts it again in its conversation';

/** What Wake does, as its hint. */
export const WAKE_HINT = 'Start it again, carrying on its conversation';

/**
 * Pause or Wake for the agent's menu and window: Wake while it is paused; Pause while it runs, disabled with why while
 * it is mid-turn or waiting on you. Neither for an ended agent, which has Restart.
 */
export function pauseControl(
  agent: Pick<Agent, 'endedAt' | 'state' | 'ask' | 'plan' | 'permissions'>,
): { action: 'pause' | 'wake'; enabled: boolean; hint: string } | undefined {
  if (agent.state === 'hibernated') return { action: 'wake', enabled: true, hint: WAKE_HINT };
  if (agent.endedAt !== null) return undefined;
  const refusal = pauseRefusal(agent);
  return { action: 'pause', enabled: refusal === undefined, hint: refusal === undefined ? PAUSE_HINT : upperFirst(refusal) };
}

/**
 * A paused tile's line, in its two parts: who ("paused by Release lead", which gives way to a narrow tile first) and
 * when ("· 14 min ago", which always shows).
 */
export function pausedLine(hibernated: NonNullable<Agent['hibernated']>, now: number): { who: string; when: string } {
  return { who: `paused by ${hibernated.by ?? 'you'}`, when: ` · ${sinceText(hibernated.at, now)}` };
}
