import { app, nativeImage, nativeTheme, Tray } from 'electron';
import dockBlueNeeds from '../../../../brand/png/dock-states/dock-blue-needs-1024.png?asset';
import dockBlueWorking from '../../../../brand/png/dock-states/dock-blue-working-1024.png?asset';
import dockBlueQuiet from '../../../../brand/png/dock-states/dock-blue-quiet-1024.png?asset';
import dockDarkNeeds from '../../../../brand/png/dock-states/dock-dark-needs-1024.png?asset';
import dockDarkWorking from '../../../../brand/png/dock-states/dock-dark-working-1024.png?asset';
import dockDarkQuiet from '../../../../brand/png/dock-states/dock-dark-quiet-1024.png?asset';
import menuBarIcon from '../../../../brand/png/menubar/menubarTemplate.png?asset';
import menuBarIcon2x from '../../../../brand/png/menubar/menubarTemplate@2x.png?asset';
import { appIndicator, type AppStatus, type DockIcon } from './app-state';

const DOCK_ICONS: Record<DockIcon, string> = {
  'dock-blue-needs': dockBlueNeeds,
  'dock-blue-working': dockBlueWorking,
  'dock-blue-quiet': dockBlueQuiet,
  'dock-dark-needs': dockDarkNeeds,
  'dock-dark-working': dockDarkWorking,
  'dock-dark-quiet': dockDarkQuiet,
};

/**
 * The menu-bar dot (brand/BRAND.md asks for `#E5484D`): an ANSI red title beside the icon. The icon is a template
 * image, which macOS tints to one colour for light and dark bars, so the dot can't be drawn into it.
 */
const MENU_BAR_DOT = '\u001b[31m●\u001b[0m';

/** The menu-bar icon: the brand's template image, at 1× and 2× (Vite renames the files, so the pair is made here). */
function menuBarImage() {
  const image = nativeImage.createFromPath(menuBarIcon);
  image.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(menuBarIcon2x).toPNG() });
  image.setTemplateImage(true);
  return image;
}

/**
 * Shows the app's state the way brand/BRAND.md's "States" asks: the dock icon swapped to the state's (in the dark
 * colourway while the app is in dark mode), the number of waiting agents on the badge, and on macOS the menu-bar icon
 * with a red dot while an agent needs you and the state as its tooltip. `menuBar: false` leaves the menu bar alone,
 * as e2e runs do; clicking the menu-bar icon calls `onClick`. Returns `show`, to call with each new status, and `stop`.
 */
export function createAppIcon({ menuBar, onClick }: { menuBar: boolean; onClick(): void }): {
  show(status: AppStatus): void;
  stop(): void;
} {
  const tray = menuBar && process.platform === 'darwin' ? new Tray(menuBarImage()) : undefined;
  tray?.on('click', onClick);
  let status: AppStatus = { state: 'quiet', waiting: 0 };

  const render = () => {
    const indicator = appIndicator(status, nativeTheme.shouldUseDarkColors ? 'dark' : 'blue');
    app.dock?.setIcon(DOCK_ICONS[indicator.dockIcon]);
    app.setBadgeCount(indicator.badge);
    tray?.setTitle(indicator.menuBarDot ? MENU_BAR_DOT : '');
    tray?.setToolTip(indicator.tooltip);
  };
  // The colourway follows the app's Appearance setting, which Electron's theme source is pointed at.
  nativeTheme.on('updated', render);
  render();

  return {
    show(next) {
      status = next;
      render();
    },
    stop() {
      nativeTheme.off('updated', render);
      tray?.destroy();
    },
  };
}
