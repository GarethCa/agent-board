import type { DaemonLink } from '@agent-board/daemon/client';
import { REVIEW_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough } from './passthrough';

/** The review IPC the preload's `reviews` API calls. Every window hears every change, so all stay in step. */
export function registerReviewIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['review.updated'], REVIEW_IPC.changed);

  passthrough(daemon, REVIEW_IPC.list, 'review.list');
  passthrough(daemon, REVIEW_IPC.start, 'review.start', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, REVIEW_IPC.send, 'review.send', (id: string) => ({ id }));
  passthrough(daemon, REVIEW_IPC.dismiss, 'review.dismiss', (id: string) => ({ id }));
  passthrough(daemon, REVIEW_IPC.merge, 'review.merge', (id: string) => ({ id }));
  passthrough(daemon, REVIEW_IPC.setCap, 'review.setCap', (sessionId: string, cap: number) => ({ sessionId, cap }));
}
