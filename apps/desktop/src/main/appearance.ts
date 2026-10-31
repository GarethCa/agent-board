import { nativeTheme } from 'electron';
import { registerFileSetting, type FileSetting } from './file-setting';
import { APPEARANCE_IPC } from '../preload/api';
import { appearanceFrom, DEFAULT_APPEARANCE, isAppearance, themeSourceFor, type Appearance } from '../shared/appearance';

/**
 * The Appearance setting: kept in `appearance.json` (file-setting.ts), so no window flashes the wrong theme. It
 * drives Electron's `nativeTheme.themeSource`, which every window's `prefers-color-scheme` follows, and macOS's own
 * parts of the windows too; a pick is sent to every window, which shows its theme (renderer/src/themes.ts). A theme
 * saved on its own moves to its family (`appearanceFrom`).
 */
export function registerAppearance(dataDir: string, fallback: Appearance = DEFAULT_APPEARANCE): FileSetting<Appearance> {
  return registerFileSetting({
    dataDir,
    name: 'appearance',
    channels: APPEARANCE_IPC,
    fallback,
    from: appearanceFrom,
    is: isAppearance,
    apply: (appearance) => (nativeTheme.themeSource = themeSourceFor(appearance)),
  });
}
