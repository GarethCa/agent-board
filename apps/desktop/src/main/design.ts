import { registerFileSetting, type FileSetting } from './file-setting';
import { DESIGN_IPC } from '../preload/api';
import { DEFAULT_DESIGN, designFrom, isDesign, type Design } from '../shared/design';

/**
 * The Simplified design setting (docs/adr/0022-simplified-design.md): kept in `design.json` (file-setting.ts), so no
 * window flashes the other design; e2e/launch.ts writes it before launching, to open in the Simplified design. A pick
 * is sent to every window, which shows it at once (renderer/src/design.ts).
 */
export function registerDesign(dataDir: string): FileSetting<Design> {
  return registerFileSetting({ dataDir, name: 'design', channels: DESIGN_IPC, fallback: DEFAULT_DESIGN, from: designFrom, is: isDesign });
}
