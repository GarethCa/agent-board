import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDaemonLink, ensureDaemon, type EnsureDaemonOptions } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { describeBuild } from '@agent-board/daemon/protocol';
import { spawnDetachedDaemon } from '@agent-board/daemon/spawn';
import { stopDaemon } from '@agent-board/daemon/stop';
import { appearanceFrom, appearanceQuery, themeFor } from '../shared/appearance';
import { APP_NAME } from '../shared/brand';
import aboutIcon from '../../../../brand/png/app-icon/icon-512.png?asset';
import { DAEMON_IPC, WINDOW_IPC, WINDOW_QUERY, type RestartDaemonResult, type WindowTarget } from '../preload/api';
import { registerAgentIpc, registerAgentOpening } from './agents';
import { registerAppearance } from './appearance';
import { backgroundMode, enterBackgroundMode, headless, revealWindow } from './background';
import { BUILD } from './build';
import { chromeOptions } from './chrome';
import { registerExternalIpc } from './external';
import { registerConnectorIpc } from './connectors';
import { registerFlowEdgeIpc } from './flow-edges';
import { registerPullRequestIpc } from './pull-requests';
import { registerGateIpc } from './gates';
import { registerAskIpc } from './asks';
import { registerCaptures } from './captures';
import { DEMO_SCALE, registerDemoCapture } from './demo-capture';
import { CAPTURE_QUERY, captureSize } from '../shared/capture';
import { registerUnsavedPlanEditIpc } from './unsaved-plan-edits';
import { registerReviewIpc } from './reviews';
import { registerOrchestratorIpc } from './orchestrators';
import { registerImageProtocol, registerImageScheme, registerItemIpc } from './items';
import { guardWindow } from './links';
import { createNotifier, registerNotifications } from './notifications';
import { registerSessionIpc } from './sessions';
import { registerSetupIpc, setAppMenu } from './setup';
import { registerShellIpc } from './shells';
import { registerTrackerIpc } from './trackers';
import { daemonViewState, registerViewIpc } from './view';
import { registerWebTabIpc } from './web-tabs';
import { registerTabDragIpc } from './tab-drags';
import { registerWindowIpc } from './windows';
import { registerZoneIpc } from './zones';

app.setName(APP_NAME);
enterBackgroundMode();
// Tests point the whole app (daemon state and Electron profile) at a temp dir.
if (process.env.AGENT_BOARD_DATA_DIR) app.setPath('userData', process.env.AGENT_BOARD_DATA_DIR);

// The icon is for Windows and Linux: macOS's About panel shows the app's own icon (the dock's, while it runs).
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: describeBuild(BUILD), version: '', iconPath: aboutIcon });

const dataDir = app.getPath('userData');
const idleTimeoutMs = process.env.AGENT_BOARD_DAEMON_IDLE_TIMEOUT_MS;
const permissionHoldMs = process.env.AGENT_BOARD_PERMISSION_HOLD_MS;
/** Demo mode records the board for the promo (demo-capture.ts). Never in a packaged build. */
const demo = !app.isPackaged && process.env.AGENT_BOARD_DEMO === '1';

/** Connects to the daemon, starting `agent-board daemon` detached (so it outlives the app) if none runs. */
const daemonConnection: EnsureDaemonOptions = {
  socketPath: daemonPaths(dataDir).socket,
  start: () =>
    spawnDetachedDaemon({
      command: process.execPath,
      args: [
        join(import.meta.dirname, 'daemon.js'),
        'daemon',
        '--data-dir',
        dataDir,
        ...(idleTimeoutMs ? ['--idle-timeout-ms', idleTimeoutMs] : []),
        ...(permissionHoldMs ? ['--permission-hold-ms', permissionHoldMs] : []),
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      logPath: daemonPaths(dataDir).log,
    }),
};
const daemon = createDaemonLink(daemonConnection);

/** The narrowest the board's window gets: the bottom bar's zones pill, dock and zoom bar fit side by side down to here. */
const BOARD_MIN_SIZE = { minWidth: 640, minHeight: 480 };

/** Opens a renderer window: the board, or with `query` set, one view of it such as a popped-out session window. */
function openWindow(
  query: Record<string, string> = {},
  {
    title = APP_NAME,
    width = 1280,
    height = 800,
    x,
    y,
    hidden = false,
    offscreenScale,
  }: { title?: string; width?: number; height?: number; x?: number; y?: number; hidden?: boolean; offscreenScale?: number } = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    title,
    // A capture window: its page is exactly its size, and it is never shown.
    ...(hidden ? { useContentSize: true, enableLargerThanScreen: true } : {}),
    // A recorded window may be bigger than the screen: it is never shown.
    ...(offscreenScale === undefined ? {} : { enableLargerThanScreen: true }),
    // The desk of the theme it opens in, so it never flashes the other one before the page paints.
    backgroundColor: themeFor(appearance.current(), nativeTheme.shouldUseDarkColors).desk,
    ...chromeOptions(process.platform, WINDOW_QUERY.popOut in query ? 'pop-out' : 'board'),
    ...(WINDOW_QUERY.popOut in query || hidden ? {} : BOARD_MIN_SIZE),
    // Background mode shows the window without focus once it has loaded; headless mode never shows it.
    show: !backgroundMode && !hidden,
    webPreferences: {
      // Headless, the page paints into a bitmap rather than the window, so it renders (and Playwright screenshots it) unshown.
      // A scale paints that many device pixels per CSS pixel, which an offscreen page otherwise paints at one.
      offscreen: headless && offscreenScale !== undefined ? { deviceScaleFactor: offscreenScale } : headless || hidden,
      sandbox: true,
      contextIsolation: true,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
    },
  });

  if (backgroundMode && !headless && !hidden) window.once('ready-to-show', () => window.showInactive());
  // macOS hides the traffic lights in full screen, and the page moves into the room they leave.
  const sendFullScreen = (fullScreen: boolean) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(WINDOW_IPC.fullScreen, fullScreen);
  };
  window.on('enter-full-screen', () => sendFullScreen(true));
  window.on('leave-full-screen', () => sendFullScreen(false));

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererFile = join(import.meta.dirname, '../renderer/index.html');
  guardWindow(window, (url) => {
    const target = new URL(url);
    return devServerUrl
      ? target.origin === new URL(devServerUrl).origin
      : target.protocol === 'file:' && target.pathname === pathToFileURL(rendererFile).pathname;
  });
  // The Appearance setting it opens in, for its first paint (renderer/src/themes.ts); later picks reach it as they happen.
  const withAppearance = { ...query, [WINDOW_QUERY.appearance]: appearanceQuery(appearance.current()) };
  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}?${new URLSearchParams(withAppearance)}`);
  } else {
    void window.loadFile(rendererFile, { query: withAppearance });
  }
  return window;
}

/** The board's window, while it is open. Popped-out session windows are not boards. */
let board: BrowserWindow | undefined;

/** Opens the board, with `showing`'s window shown on it, and returns its window. */
function openBoard(showing?: WindowTarget): BrowserWindow {
  // Benchmarks fill the board with placeholder tiles and sticky notes (see e2e/board-perf.spec.ts). Never in a packaged build.
  const placeholders = app.isPackaged ? undefined : process.env.AGENT_BOARD_PLACEHOLDER_TILES;
  const stickies = app.isPackaged ? undefined : process.env.AGENT_BOARD_PLACEHOLDER_STICKIES;
  const window = openWindow(
    {
      // Tests keep onboarding from opening by itself on their empty boards, packaged or not; onboarding.spec.ts opts in.
      ...(process.env.AGENT_BOARD_ONBOARDING === '0' ? { onboarding: 'off' } : {}),
      ...(placeholders ? { placeholders } : {}),
      ...(stickies ? { stickies } : {}),
      ...(showing ? { [WINDOW_QUERY.show]: showing.id, [WINDOW_QUERY.kind]: showing.kind, [WINDOW_QUERY.title]: showing.title } : {}),
    },
    demo ? { offscreenScale: DEMO_SCALE } : {},
  );
  board = window;
  window.on('closed', () => {
    if (board === window) board = undefined;
  });
  return window;
}

ipcMain.handle(DAEMON_IPC.health, () => daemon.call('daemon.health'));
ipcMain.handle(DAEMON_IPC.build, () => BUILD);
// The renderer asks without `force` first, so live sessions are counted at the moment of the restart, not when the
// banner appeared. The next call starts this build's daemon.
ipcMain.handle(DAEMON_IPC.restart, async (_event, force: unknown): Promise<RestartDaemonResult> => {
  const stopped = await stopDaemon(dataDir, { force: force === true });
  if (stopped.status === 'sessions-live') return stopped;
  await daemon.call('daemon.health');
  return { status: 'restarted' };
});
registerSessionIpc(daemon, () => ensureDaemon(daemonConnection));
registerZoneIpc(daemon);
registerImageScheme();
registerItemIpc(daemon, dataDir);
registerConnectorIpc(daemon);
registerFlowEdgeIpc(daemon);
registerReviewIpc(daemon);
registerPullRequestIpc(daemon);
registerGateIpc(daemon);
registerAskIpc(daemon);
registerUnsavedPlanEditIpc();
// The board's window may hand off any window's web tab, as it makes every move.
registerWebTabIpc({ isBoard: (contents) => board !== undefined && !board.isDestroyed() && board.webContents === contents });
registerOrchestratorIpc(daemon);
registerAgentIpc(daemon, dataDir);
registerShellIpc(daemon);
registerExternalIpc(daemon);
registerTrackerIpc(daemon);
const notify = createNotifier();
registerSetupIpc(daemon, notify);
// Before any window opens. Tests pin the theme with AGENT_BOARD_APPEARANCE, the default when nothing was picked, so a
// machine in dark mode doesn't change their screenshots.
const appearance = registerAppearance(dataDir, appearanceFrom(process.env.AGENT_BOARD_APPEARANCE));
const view = daemonViewState(daemon);
registerViewIpc(view);
const poppedWindows = registerWindowIpc({
  open: openWindow,
  view,
  board: () => board,
  openBoard,
});
// Pictures of zones for orchestrators, each in a hidden board window framed on its zone.
registerCaptures({
  daemon,
  served: () => view.remeasure(),
  openBoard: (frame) => openWindow({ [CAPTURE_QUERY]: JSON.stringify(frame), onboarding: 'off' }, { ...captureSize(frame), hidden: true }),
});
if (demo) registerDemoCapture(() => board);
registerTabDragIpc({ board: () => board, openBoard: () => openBoard(), poppedOwner: poppedWindows.poppedOwner });
const openAgent = registerAgentOpening(() => board ?? openBoard());

let stopNotifications: (() => void) | undefined;

void app.whenReady().then(() => {
  registerImageProtocol(dataDir);
  stopNotifications = registerNotifications(daemon, notify, openAgent, () => revealWindow(board ?? openBoard()));
  setAppMenu(() => board ?? openBoard());
  // Start (or find) the daemon at launch, not when the window first asks.
  daemon.call('daemon.health').catch((error: unknown) => console.error('agent-board: could not reach the daemon:', error));
  openBoard();
  // A popped-out session window may still be open: the board comes back whenever it is missing.
  app.on('activate', () => {
    if (board === undefined) openBoard();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Disconnecting lets the daemon exit once it is idle; it keeps running while sessions are alive.
app.on('will-quit', () => {
  stopNotifications?.();
  daemon.close();
});
