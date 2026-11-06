import { registerFileSetting, type FileSetting } from './file-setting';
import { DOCK_IPC } from '../preload/api';
import { DEFAULT_DOCK, dockFrom, isDockMode, type DockMode } from '../shared/dock';

/**
 * The Dock setting (shared/dock.ts): kept in `dock.json` (file-setting.ts), so no window paints the dock wrong. A pick
 * is sent to every window, which follows it at once (renderer/src/dock.ts).
 */
export function registerDock(dataDir: string): FileSetting<DockMode> {
  return registerFileSetting({ dataDir, name: 'dock', channels: DOCK_IPC, fallback: DEFAULT_DOCK, from: dockFrom, is: isDockMode });
}
