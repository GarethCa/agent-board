import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import {
  RPC_ERROR,
  zoneSnapshot,
  TRACKER_ERROR,
  type NewZoneParams,
  type Zone,
  type ZoneBinding,
  type ZoneLayout,
  type ZoneSettings,
  type ZoneSnapshot,
  type ZoneTracker,
} from '@agent-board/daemon/protocol';
import {
  ZONE_IPC,
  type AddFolderResult,
  type AddZoneResult,
  type BindZoneResult,
  type CheckFolderResult,
  type GitHubReposResult,
} from '../preload/api';
import { forwardEvents } from './broadcast';

const PICK_FOLDER: OpenDialogOptions = {
  title: 'Add a zone',
  message: 'Pick a git repo, or a folder inside one',
  buttonLabel: 'Add zone',
  properties: ['openDirectory'],
};

const BIND_REPO: OpenDialogOptions = {
  title: 'Open as repo',
  message: 'Pick a git repo, or a folder inside one',
  buttonLabel: 'Bind zone',
  properties: ['openDirectory'],
};

const BIND_PROJECT: OpenDialogOptions = {
  title: 'Open as project',
  message: 'Pick or create an empty folder for the new project',
  buttonLabel: 'Create project',
  properties: ['openDirectory', 'createDirectory'],
};

/**
 * The zone IPC the preload's `zones` API calls. Browsing for a folder, to add or bind a zone, asks the user here, in
 * main. Every window hears every zone change, so boards stay in step.
 */
export function registerZoneIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['zone.updated', 'zone.removed'], ZONE_IPC.changed);
  ipcMain.handle(ZONE_IPC.list, () => daemon.call('zone.list'));
  ipcMain.handle(ZONE_IPC.add, async (event, params: NewZoneParams): Promise<AddZoneResult> => {
    const result = await withPickedFolder(event, PICK_FOLDER, (path) => daemon.call('zone.add', { ...newZone(params), path }));
    return result.status === 'done' ? { status: 'added', zone: result.zone } : result;
  });
  ipcMain.handle(ZONE_IPC.addFolder, async (_event, path: string, params: NewZoneParams): Promise<AddFolderResult> => {
    const result = await refusable(() => daemon.call('zone.add', { ...newZone(params), path }));
    return result.status === 'done' ? { status: 'added', zone: result.zone } : result;
  });
  ipcMain.handle(ZONE_IPC.addUnbound, (_event, params: { name: string } & NewZoneParams) =>
    daemon.call('zone.addUnbound', { ...newZone(params), name: params.name }),
  );
  ipcMain.handle(ZONE_IPC.clone, (_event, repo: string, params: NewZoneParams) =>
    daemon.call('zone.clone', { ...newZone(params), repo }),
  );
  ipcMain.handle(ZONE_IPC.cancelClone, async (_event, id: string) => {
    await daemon.call('zone.cancelClone', { id });
  });
  ipcMain.handle(ZONE_IPC.recentFolders, () => daemon.call('zone.recentFolders'));
  ipcMain.handle(ZONE_IPC.githubRepos, async (): Promise<GitHubReposResult> => {
    try {
      return { status: 'ok', repos: await daemon.call('zone.githubRepos') };
    } catch (error) {
      // gh not logged in, or its login refused: the user must log in. Anything else (offline) is reported.
      if (error instanceof DaemonRpcError && error.code === TRACKER_ERROR.unauthorized) {
        return { status: 'needsLogin', refused: error.message };
      }
      throw error;
    }
  });
  ipcMain.handle(ZONE_IPC.checkFolder, async (_event, path: string, repo?: string): Promise<CheckFolderResult> => {
    try {
      return { status: 'ok', folder: await daemon.call('zone.checkFolder', { path: String(path), ...(repo === undefined ? {} : { repo: String(repo) }) }) };
    } catch (error) {
      // The daemon refused the folder (not in a git repo, another repo's): its message is meant for the user.
      if (error instanceof DaemonRpcError && error.code === RPC_ERROR.invalidParams) return { status: 'rejected', message: error.message };
      throw error;
    }
  });
  ipcMain.handle(ZONE_IPC.findCopies, async () => (await daemon.call('zone.findCopies')).found);
  ipcMain.handle(ZONE_IPC.bind, async (event, id: string, as: ZoneBinding): Promise<BindZoneResult> => {
    const result = await withPickedFolder(event, as === 'project' ? BIND_PROJECT : BIND_REPO, (path) =>
      daemon.call('zone.bind', { id, as, path }),
    );
    return result.status === 'done' ? { status: 'bound', zone: result.zone } : result;
  });
  ipcMain.handle(ZONE_IPC.update, (_event, id: string, layout: ZoneLayout) =>
    daemon.call('zone.update', { id, ...layout }),
  );
  ipcMain.handle(ZONE_IPC.configure, (_event, id: string, settings: Partial<ZoneSettings>) => {
    const { codexBypassHookTrust, boardMcp, agentsOrchestrate, gateCommand } = settings;
    return daemon.call('zone.configure', { id, codexBypassHookTrust, boardMcp, agentsOrchestrate, gateCommand });
  });
  ipcMain.handle(ZONE_IPC.setTracker, (_event, id: string, tracker: ZoneTracker | null) =>
    daemon.call('zone.setTracker', { id, tracker }),
  );
  ipcMain.handle(ZONE_IPC.unbind, (_event, id: string) => daemon.call('zone.unbind', { id }));
  ipcMain.handle(ZONE_IPC.setDefaultRepo, (_event, id: string, path: string | null) =>
    daemon.call('zone.setDefaultRepo', { id, path }),
  );
  ipcMain.handle(ZONE_IPC.roleTemplates, (_event, id: string) => daemon.call('zone.roleTemplates', { id }));
  ipcMain.handle(ZONE_IPC.setRoleTemplate, (_event, id: string, role: string, body: string) =>
    daemon.call('zone.setRoleTemplate', { id, role, body }),
  );
  ipcMain.handle(ZONE_IPC.resetRoleTemplate, (_event, id: string, role: string) =>
    daemon.call('zone.resetRoleTemplate', { id, role }),
  );
  ipcMain.handle(ZONE_IPC.setLook, (_event, id: string, look: { name?: string; color?: string; fillOpacity?: number | null }) =>
    daemon.call('zone.setLook', { id, name: look.name, color: look.color, fillOpacity: look.fillOpacity }),
  );
  ipcMain.handle(ZONE_IPC.dissolve, (_event, id: string, options?: { deleteClone?: boolean }) =>
    daemon.call('zone.dissolve', { id, deleteClone: options?.deleteClone === true }),
  );
  ipcMain.handle(ZONE_IPC.restore, (_event, zone: ZoneSnapshot) => daemon.call('zone.restore', zoneSnapshot(zone)));
  ipcMain.handle(ZONE_IPC.browseFolder, async (event, title: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: String(title), buttonLabel: 'Choose', properties: ['openDirectory'] };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return picked.canceled ? undefined : picked.filePaths[0];
  });
}

/** Only the fields of a new zone the daemon takes, whatever else the renderer sent. */
function newZone({ x, y, width, height, name, color, tracker }: NewZoneParams): NewZoneParams {
  return { x, y, width, height, name, color, tracker };
}

/** Asks the user for a folder, then hands it to `use`; a folder the daemon refuses comes back with its reason. */
async function withPickedFolder(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions,
  use: (path: string) => Promise<Zone>,
): Promise<{ status: 'done'; zone: Zone } | { status: 'cancelled' } | { status: 'rejected'; message: string }> {
  const window = BrowserWindow.fromWebContents(event.sender);
  const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
  const path = picked.filePaths[0];
  if (picked.canceled || path === undefined) return { status: 'cancelled' };
  return refusable(() => use(path));
}

/** Runs `use`; a folder or tracker the daemon refuses comes back with its reason. */
async function refusable(
  use: () => Promise<Zone>,
): Promise<{ status: 'done'; zone: Zone } | { status: 'rejected'; message: string }> {
  try {
    return { status: 'done', zone: await use() };
  } catch (error) {
    // The daemon refused the folder (missing, not in a git repo, not empty): its message is meant for the user.
    if (error instanceof DaemonRpcError && error.code === RPC_ERROR.invalidParams) {
      return { status: 'rejected', message: error.message };
    }
    throw error;
  }
}
