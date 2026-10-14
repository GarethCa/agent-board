import { ipcMain } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { TRACKER_ERROR, type TrackerProvider } from '@agent-board/daemon/protocol';
import { TRACKER_IPC, type ScopesResult } from '../preload/api';
import { openWebLink } from './links';
import { passthrough, passthroughVoid } from './passthrough';

/** The tracker IPC the preload's `trackers` API calls. Credentials pass through to the daemon and are never kept here. */
export function registerTrackerIpc(daemon: DaemonLink): void {
  passthrough(daemon, TRACKER_IPC.status, 'tracker.status', (provider: TrackerProvider) => ({ provider }));
  passthrough(daemon, TRACKER_IPC.connect, 'tracker.connect', (provider: TrackerProvider, credential: string) => ({ provider, credential }));
  passthroughVoid(daemon, TRACKER_IPC.disconnect, 'tracker.disconnect', (provider: TrackerProvider) => ({ provider }));
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
  passthrough(daemon, TRACKER_IPC.projects, 'tracker.projects', (provider: TrackerProvider, scope: string) => ({ provider, scope }));
  passthrough(daemon, TRACKER_IPC.issues, 'tracker.issues', (zoneId: string, query?: string) => ({ zoneId, query }));
  // Tracker issues' and notes' links. Only https: the URL comes from outside the app.
  ipcMain.handle(TRACKER_IPC.openLink, (_event, url: string) => openWebLink(url));
}
