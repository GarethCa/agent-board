import type { DaemonLink } from '@agent-board/daemon/client';
import type { AskAnswer, PlanOutcome } from '@agent-board/daemon/protocol';
import { ASK_IPC } from '../preload/api';
import { passthrough, passthroughVoid } from './passthrough';

/**
 * The IPC for agents' questions and plans. Each agent's update carries its question and latest plan; the
 * user's click answers or decides, and nothing else does.
 */
export function registerAskIpc(daemon: DaemonLink): void {
  passthroughVoid(daemon, ASK_IPC.answer, 'ask.answer', (sessionId: string, askId: string, answer: AskAnswer) => ({ sessionId, askId, answer }));
  passthrough(daemon, ASK_IPC.plans, 'plan.list', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, ASK_IPC.decide, 'plan.decide', (sessionId: string, planId: string, outcome: PlanOutcome, comments: string) => ({ sessionId, planId, outcome, comments }));
}
