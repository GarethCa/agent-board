import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { parsePrefab, prefabFile } from '@agent-board/daemon/crew-prefabs';
import { DEFAULT_ACTIVITY_LIMIT, type CrewPrefab } from '@agent-board/daemon/protocol';
import { ORCHESTRATOR_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough, passthroughVoid } from './passthrough';

/** A prefab's name as the library matches it: trimmed, its ASCII letters in either case. */
const asciiFolded = (name: string) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The orchestrator IPC the preload's `orchestrators` API calls: the activity log, read and heard as it grows, and the
 * crew prefab library, which the app reads and writes as the user.
 */
export function registerOrchestratorIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['orchestrator.activity'], ORCHESTRATOR_IPC.logged);
  forwardEvents(daemon, ['usage.updated'], ORCHESTRATOR_IPC.usageChanged);
  passthrough(daemon, ORCHESTRATOR_IPC.usage, 'usage.get');

  ipcMain.handle(ORCHESTRATOR_IPC.activity, (_event, orchestratorId: string, before?: number) =>
    daemon.call('orchestrator.activity', { orchestratorId, limit: DEFAULT_ACTIVITY_LIMIT, ...(before === undefined ? {} : { before }) }),
  );
  passthrough(daemon, ORCHESTRATOR_IPC.prefabs, 'orchestrator.prefabs', () => ({}));
  // Read as the library reads it, by its own parser: why it would refuse the draft, or null.
  ipcMain.handle(ORCHESTRATOR_IPC.checkPrefab, (_event, prefab: CrewPrefab) => {
    try {
      parsePrefab(prefabFile(prefab));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });
  // Written as its file, so the library reads an edit as strictly as an imported file. Renamed: the new name is saved
  // first, then the old one removed, so a refused save loses nothing. Names match as the library's do, in ASCII case.
  ipcMain.handle(ORCHESTRATOR_IPC.savePrefab, async (_event, prefab: CrewPrefab, replaces?: string) => {
    const renamed = replaces !== undefined && asciiFolded(replaces) !== asciiFolded(prefab.name);
    const saved = await daemon.call('orchestrator.savePrefab', { text: prefabFile(prefab), replace: replaces !== undefined && !renamed });
    if (renamed) {
      // Gone already (removed from a shell meanwhile): the rename is done all the same.
      await daemon.call('orchestrator.removePrefab', { name: replaces }).catch((error: Error) => {
        if (!/has no crew prefab named/.test(error.message)) throw error;
      });
    }
    return saved;
  });
  passthroughVoid(daemon, ORCHESTRATOR_IPC.removePrefab, 'orchestrator.removePrefab', (name: string) => ({ name }));
}
