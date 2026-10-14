import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { REVIEW_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The review IPC the preload's `reviews` API calls. Every window hears every change, so all stay in step. */
export function registerReviewIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['review.updated'], REVIEW_IPC.changed);

  ipcMain.handle(REVIEW_IPC.list, () => daemon.call('review.list'));
  ipcMain.handle(REVIEW_IPC.start, (_event, sessionId: string) => daemon.call('review.start', { sessionId }));
  ipcMain.handle(REVIEW_IPC.send, (_event, id: string) => daemon.call('review.send', { id }));
  ipcMain.handle(REVIEW_IPC.dismiss, (_event, id: string) => daemon.call('review.dismiss', { id }));
  ipcMain.handle(REVIEW_IPC.merge, (_event, id: string) => daemon.call('review.merge', { id }));
  ipcMain.handle(REVIEW_IPC.setCap, (_event, sessionId: string, cap: number) => daemon.call('review.setCap', { sessionId, cap }));
}
