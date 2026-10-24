import type { DaemonLink } from '@agent-board/daemon/client';
import type { AskAnswer, PlanOutcome } from '@agent-board/daemon/protocol';
import { ASK_IPC } from '../preload/api';
import { passthrough, passthroughVoid } from './passthrough';

/**
 * The IPC for agents' questions, plans and documents. Each agent's update carries its question and latest plan; the
 * user's click answers or decides, and nothing else does.
 */
export function registerAskIpc(daemon: DaemonLink): void {
  passthroughVoid(daemon, ASK_IPC.answer, 'ask.answer', (sessionId: string, askId: string, answer: AskAnswer) => ({ sessionId, askId, answer }));
  passthroughVoid(daemon, ASK_IPC.place, 'ask.place', (sessionId: string, askId: string, at: { x: number; y: number }) => ({ sessionId, askId, at }));
  passthrough(daemon, ASK_IPC.plans, 'plan.list', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, ASK_IPC.decide, 'plan.decide', (sessionId: string, planId: string, outcome: PlanOutcome, comments: string) => ({ sessionId, planId, outcome, comments }));
  passthrough(daemon, ASK_IPC.editPlan, 'plan.edit', (sessionId: string, planId: string, body: string) => ({ sessionId, planId, body }));
  // Documents agents show: the user reads them, and their edits and comments go to the agent.
  passthrough(daemon, ASK_IPC.readDoc, 'doc.read', (documentId: string) => ({ documentId }));
  passthrough(daemon, ASK_IPC.saveDoc, 'doc.save', (documentId: string, text: string, baseVersion: number, force?: boolean) => ({ documentId, text, baseVersion, ...(force === true ? { force } : {}) }));
  passthroughVoid(daemon, ASK_IPC.commentDoc, 'doc.comment', (documentId: string, text: string) => ({ documentId, text }));
}
