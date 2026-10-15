import type { DaemonLink } from '@agent-board/daemon/client';
import type { GateCleanup } from '@agent-board/daemon/protocol';
import { GATE_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough } from './passthrough';

/**
 * The merge gate's IPC. Every window hears every run change, so tiles, tabs and headers stay in step. The daemon
 * runs the gate and asks GitHub, only when the user clicks.
 */
export function registerGateIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['gate.updated'], GATE_IPC.changed);

  passthrough(daemon, GATE_IPC.list, 'gate.list');
  passthrough(daemon, GATE_IPC.status, 'gate.status', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, GATE_IPC.run, 'gate.run', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, GATE_IPC.stop, 'gate.stop', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, GATE_IPC.log, 'gate.log', (sessionId: string, step?: string, since?: number) => ({ sessionId, step, since }));
  passthrough(daemon, GATE_IPC.openPullRequest, 'gate.openPullRequest', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, GATE_IPC.sendFailure, 'gate.sendFailure', (sessionId: string, step: string) => ({ sessionId, step }));
  passthrough(daemon, GATE_IPC.merge, 'gate.merge', (sessionId: string, number: number, headCommit: string, cleanup: GateCleanup) => ({
    sessionId,
    number,
    headCommit,
    cleanup: { close: cleanup.close, worktree: cleanup.worktree, branch: cleanup.branch, comment: cleanup.comment },
  }));
}
