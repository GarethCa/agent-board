import { ipcMain } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { TRACKER_ERROR, type TrackerProvider } from '@agent-board/daemon/protocol';
import { TRACKER_IPC, type ScopesResult } from '../preload/api';
import { openWebLink } from './links';

/** The tracker IPC the preload's `trackers` API calls. Credentials pass through to the daemon and are never kept here. */
export function registerTrackerIpc(daemon: DaemonLink): void {
  ipcMain.handle(TRACKER_IPC.status, (_event, provider: TrackerProvider) =>
    daemon.call('tracker.status', { provider }),
  );
  ipcMain.handle(TRACKER_IPC.connect, (_event, provider: TrackerProvider, credential: string) =>
    daemon.call('tracker.connect', { provider, credential }),
  );
  ipcMain.handle(TRACKER_IPC.disconnect, async (_event, provider: TrackerProvider) => {
    await daemon.call('tracker.disconnect', { provider });
  });
  ipcMain.handle(TRACKER_IPC.scopes, async (_event, provider: TrackerProvider): Promise<ScopesResult> => {
    try {
      return { status: 'ok', scopes: await daemon.call('tracker.scopes', { provider }) };
    } catch (error) {
      // Only a missing or refused credential needs a new one; anything else (offline, keychain errors) is reported.
      const { notConnected, unauthorized } = TRACKER_ERROR;
      if (error instanceof DaemonRpcError && (error.code === notConnected || error.code === unauthorized)) {
        return { status: 'needsCredential', refused: error.code === unauthorized ? error.message : undefined };
      }
      throw error;
    }
  });
  ipcMain.handle(TRACKER_IPC.projects, (_event, provider: TrackerProvider, scope: string) =>
    daemon.call('tracker.projects', { provider, scope }),
  );
  ipcMain.handle(TRACKER_IPC.issues, (_event, zoneId: string, query?: string) =>
    daemon.call('tracker.issues', { zoneId, query }),
  );
  // Tracker issues' and notes' links. Only https: the URL comes from outside the app.
  ipcMain.handle(TRACKER_IPC.openLink, (_event, url: string) => openWebLink(url));
}
