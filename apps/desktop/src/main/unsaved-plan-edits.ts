import { ipcMain, type WebContents } from 'electron';
import { sendToAllWindows } from './broadcast';
import { ASK_IPC } from '../preload/api';
import { planEditKey } from '../shared/plan-edits';

/**
 * The plans with an unsaved edit in some window's Plan tab. A draft lives in its window, which may be a popped-out
 * one; every decision bar on the plan, in any window, is held while one stands. Each window's marks are kept apart, so
 * a window that closes takes only its own.
 */
export interface UnsavedPlanEdits {
  /** Window `windowId` has (`changed`), or no longer has, an unsaved edit of the agent's plan `planId`. */
  mark(windowId: number, sessionId: string, planId: string, changed: boolean): void;
  /** The window closed: its drafts went with it. */
  windowGone(windowId: number): void;
  /** Every plan held now, by `planEditKey`, sorted. */
  keys(): string[];
}

/** Keeps the marks, and calls `send` with every plan held whenever that changes. */
export function createUnsavedPlanEdits(send: (keys: string[]) => void): UnsavedPlanEdits {
  const byWindow = new Map<number, Set<string>>();
  const keys = () => [...new Set([...byWindow.values()].flatMap((marks) => [...marks]))].sort();
  const changedBy = (update: () => void) => {
    const before = keys().join('\n');
    update();
    const after = keys();
    if (after.join('\n') !== before) send(after);
  };
  return {
    mark(windowId, sessionId, planId, changed) {
      changedBy(() => {
        const marks = byWindow.get(windowId) ?? new Set<string>();
        if (changed) marks.add(planEditKey(sessionId, planId));
        else marks.delete(planEditKey(sessionId, planId));
        if (marks.size === 0) byWindow.delete(windowId);
        else byWindow.set(windowId, marks);
      });
    },
    windowGone(windowId) {
      changedBy(() => byWindow.delete(windowId));
    },
    keys,
  };
}

/** The IPC for unsaved plan edits: each window marks its own, and hears every window's. */
export function registerUnsavedPlanEditIpc(): void {
  const edits = createUnsavedPlanEdits((keys) => sendToAllWindows(ASK_IPC.unsavedEditsChanged, keys));
  const watched = new WeakSet<WebContents>();
  ipcMain.handle(ASK_IPC.markUnsavedEdit, (event, sessionId: string, planId: string, changed: boolean) => {
    const { sender } = event;
    if (!watched.has(sender)) {
      watched.add(sender);
      const { id } = sender;
      // Its drafts go as its page does: closed, crashed, or loaded again.
      const gone = () => edits.windowGone(id);
      sender.once('destroyed', gone);
      sender.on('did-navigate', gone);
      sender.on('render-process-gone', gone);
    }
    edits.mark(sender.id, sessionId, planId, changed);
  });
  ipcMain.handle(ASK_IPC.unsavedEdits, () => edits.keys());
}
