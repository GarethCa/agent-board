import { registerFileSetting, type FileSetting } from './file-setting';
import { TECHNICAL_IPC } from '../preload/api';

/**
 * The Show technical details switch (docs/adr/0022-simplified-design.md): kept in `technical.json` (file-setting.ts), so
 * no window paints the technical layer wrong; e2e/launch.ts writes it before launching. A pick is sent to every window
 * (renderer/src/technical.ts) and to the View menu, whose checkbox follows it and picks it too (setup.ts).
 */
export function registerTechnical(dataDir: string): FileSetting<boolean> {
  return registerFileSetting({
    dataDir,
    name: 'technical',
    channels: TECHNICAL_IPC,
    fallback: false,
    from: (saved) => saved === true,
    is: (value): value is boolean => typeof value === 'boolean',
  });
}
