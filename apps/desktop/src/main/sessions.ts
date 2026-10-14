import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ipcMain, shell, type WebContents } from 'electron';
import type { DaemonClient, DaemonLink } from '@agent-board/daemon/client';
import type {
  DaemonEvent,
  SessionExitedEvent,
  SessionInfo,
  SessionOutputEvent,
  SessionSnapshotEvent,
  TerminalSize,
} from '@agent-board/daemon/protocol';
import { SESSION_IPC, type SessionStreamEvent } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The daemon events a session window gets about the session it shows. */
function isSessionStreamEvent(event: DaemonEvent): event is SessionSnapshotEvent | SessionOutputEvent | SessionExitedEvent {
  return event.type === 'session.snapshot' || event.type === 'session.output' || event.type === 'session.exited';
}

/**
 * The session IPC the preload's `sessions` API calls. Requests go over the shared daemon link. Each attachment (a
 * session window showing a session) gets its own daemon connection, so the daemon's per-connection attach gives it
 * its own snapshot and output, and closing the window or its renderer just closes that connection.
 */
export function registerSessionIpc(daemon: DaemonLink, connect: () => Promise<DaemonClient>): void {
  const attachments = new Map<string, { client: DaemonClient; sender: WebContents }>();
  const watched = new WeakSet<WebContents>();
  /** Attachments whose connection is still opening, and those of them detached meanwhile. */
  const opening = new Set<string>();
  const cancelled = new Set<string>();
  const close = (attachId: string) => {
    if (opening.has(attachId)) cancelled.add(attachId);
    const attachment = attachments.get(attachId);
    attachments.delete(attachId);
    attachment?.client.close();
  };

  // Every window hears about every session that ends, so lists of sessions stay current.
  forwardEvents(daemon, ['session.exited'], SESSION_IPC.exited);

  ipcMain.handle(SESSION_IPC.list, () => daemon.call('session.list'));
  ipcMain.handle(SESSION_IPC.resize, async (_event, sessionId: string, size: TerminalSize) => {
    await daemon.call('session.resize', { sessionId, ...size });
  });
  ipcMain.handle(SESSION_IPC.kill, (_event, sessionId: string): Promise<SessionInfo> => daemon.call('session.kill', { sessionId }));
  ipcMain.handle(SESSION_IPC.cwd, async (_event, sessionId: string): Promise<string> => (await daemon.call('session.cwd', { sessionId })).cwd);
  ipcMain.handle(SESSION_IPC.openFolder, async (_event, path: string) => {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error(`not a folder: ${path}`);
    const failure = await shell.openPath(path);
    if (failure !== '') throw new Error(failure);
  });
  // Keystrokes are fire-and-forget; the link writes them to the daemon in order.
  ipcMain.on(SESSION_IPC.write, (_event, sessionId: string, data: string) => {
    daemon.call('session.write', { sessionId, data }).catch(() => {
      // The session ended or the daemon went away; the window hears about either on its attachment.
    });
  });

  ipcMain.handle(SESSION_IPC.attach, async (event, sessionId: string, attachId: string) => {
    const sender = event.sender;
    opening.add(attachId);
    let client: DaemonClient;
    try {
      client = await connect();
    } catch (error) {
      cancelled.delete(attachId);
      throw error;
    } finally {
      opening.delete(attachId);
    }
    if (cancelled.delete(attachId)) return client.close();
    attachments.set(attachId, { client, sender });
    const send = (streamEvent: SessionStreamEvent) => {
      if (!sender.isDestroyed()) sender.send(SESSION_IPC.event, attachId, streamEvent);
    };
    client.onEvent((daemonEvent) => {
      if (isSessionStreamEvent(daemonEvent) && daemonEvent.sessionId === sessionId) send(daemonEvent);
    });
    void client.closed.then(() => {
      // Closed by us on detach, or dropped by the daemon: only the second is news to the window.
      if (attachments.delete(attachId)) send({ type: 'session.detached', sessionId });
    });
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once('destroyed', () => {
        for (const [id, attachment] of attachments) if (attachment.sender === sender) close(id);
      });
    }
    try {
      await client.call('session.attach', { sessionId });
    } catch (error) {
      attachments.delete(attachId);
      client.close();
      throw error;
    }
  });
  ipcMain.handle(SESSION_IPC.detach, (_event, attachId: string) => close(attachId));
}
