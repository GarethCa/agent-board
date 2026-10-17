import type { DaemonLink } from '@agent-board/daemon/client';
import type { PullRequestRef } from '@agent-board/daemon/protocol';
import { PULL_REQUEST_IPC } from '../preload/api';
import { passthrough } from './passthrough';

/** The PR tab's IPC: the daemon asks GitHub with gh, so the renderer only ever sees what it answers. */
export function registerPullRequestIpc(daemon: DaemonLink): void {
  passthrough(daemon, PULL_REQUEST_IPC.details, 'pullRequest.details', (ref: PullRequestRef) => ({ repo: ref.repo, number: ref.number }));
  passthrough(daemon, PULL_REQUEST_IPC.approve, 'pullRequest.approve', (ref: PullRequestRef, headCommit: string) => ({ repo: ref.repo, number: ref.number, headCommit }));
  passthrough(daemon, PULL_REQUEST_IPC.merge, 'pullRequest.merge', (ref: PullRequestRef, headCommit: string, pastGate: boolean) => ({
    repo: ref.repo,
    number: ref.number,
    headCommit,
    pastGate,
  }));
}
