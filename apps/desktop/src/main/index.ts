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
import { traceNotificationClick } from './click-trace';
import { registerAppearance } from './appearance';
import { registerDesign } from './design';
import { registerTechnical } from './technical';
import { registerDock } from './dock';
import { backgroundMode, enterBackgroundMode, headless, revealWindow } from './background';
import { BUILD } from './build';
import { chromeFor, chromeOptions } from './chrome';
import { registerExternalIpc } from './external';
import { registerConnectorIpc } from './connectors';
import { registerFlowEdgeIpc } from './flow-edges';
import { registerPullRequestIpc } from './pull-requests';
import { registerGateIpc } from './gates';
import { registerAskIpc } from './asks';
import { registerCaptures } from './captures';
import { DEMO_SCALE, registerDemoCapture } from './demo-capture';
import { CAPTURE_QUERY, captureSize } from '../shared/capture';
import { VIEW_KEYS } from '../shared/view-saver';
import { registerUnsavedPlanEditIpc } from './unsaved-plan-edits';
import { registerReviewIpc } from './reviews';
import { registerOrchestratorIpc } from './orchestrators';
import { registerImageProtocol, registerImageScheme, registerItemIpc } from './items';
import { guardWindow } from './links';
import { createNotifier, registerNotifications } from './notifications';
import { registerSessionIpc } from './sessions';
import { registerSettingsWindow } from './settings-window';
import { registerOverviewWindow } from './overview-window';
import { registerSetupIpc, setAppMenu } from './setup';
import { registerShellIpc } from './shells';
import { registerTrackerIpc } from './trackers';
import { daemonViewState, registerViewIpc } from './view';
import { clearWebLogins, registerWebTabIpc } from './web-tabs';
import { pageKeys } from './page-keys';
import { registerTabDragIpc } from './tab-drags';
import { registerWindowIpc } from './windows';
import { registerZoneIpc } from './zones';

app.setName(APP_NAME);
enterBackgroundMode();
// Tests point the whole app (daemon state and Electron profile) at a temp dir.
if (process.env.AGENT_BOARD_DATA_DIR) app.setPath('userData', process.env.AGENT_BOARD_DATA_DIR);

// One app per data dir. A second launch (a notification clicked once the first has gone, a double-click on the icon)
// must not open a second board: it hands over to the first, which brings its board forward, and exits.
if (!app.requestSingleInstanceLock()) {
  // Before `ready` this ends the process during module evaluation: nothing below runs in the losing instance.
  console.error(`agent-board is already running on ${app.getPath('userData')}; bringing it forward`);
  app.exit(0);
}

// The icon is for Windows and Linux: macOS's About panel shows the app's own icon (the dock's, while it runs).
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: describeBuild(BUILD), version: '', iconPath: aboutIcon });

const dataDir = app.getPath('userData');
const idleTimeoutMs = process.env.AGENT_BOARD_DAEMON_IDLE_TIMEOUT_MS;
const permissionHoldMs = process.env.AGENT_BOARD_PERMISSION_HOLD_MS;
/** Demo mode records the board for a demo video (demo-capture.ts). Never in a packaged build. */
const demo = !app.isPackaged && process.env.AGENT_BOARD_DEMO === '1';
/** How many device pixels per CSS pixel a headless test's board paints, as a Retina display does. Never in a packaged build. */
const testScale = app.isPackaged ? undefined : Number(process.env.AGENT_BOARD_TEST_DEVICE_SCALE) || undefined;

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

/** The narrowest the Settings window gets: its sidebar and a page of rows still fit side by side. */
const SETTINGS_MIN_SIZE = { minWidth: 620, minHeight: 400 };

/** The narrowest the Overview window gets: its toolbar on two rows and two columns of threads side by side. */
const OVERVIEW_MIN_SIZE = { minWidth: 720, minHeight: 420 };

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
    parent,
  }: { title?: string; width?: number; height?: number; x?: number; y?: number; hidden?: boolean; offscreenScale?: number; parent?: BrowserWindow } = {},
): BrowserWindow {
  const kind = chromeFor(query);
  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    title,
    // A child window stays on its parent's Space, so it must not be able to take a full-screen one of its own.
    ...(parent === undefined ? {} : { parent, fullscreenable: false }),
    // A capture window: its page is exactly its size, and it is never shown.
    ...(hidden ? { useContentSize: true, enableLargerThanScreen: true } : {}),
    // A recorded window may be bigger than the screen: it is never shown.
    ...(offscreenScale === undefined ? {} : { enableLargerThanScreen: true }),
    // The desk of the theme it opens in (the same under either design), so it never flashes another before the page paints.
    backgroundColor: themeFor(appearance.current(), nativeTheme.shouldUseDarkColors).desk,
    ...chromeOptions(process.platform, kind),
    ...(kind === 'settings' ? SETTINGS_MIN_SIZE : kind === 'overview' ? OVERVIEW_MIN_SIZE : kind === 'pop-out' || hidden ? {} : BOARD_MIN_SIZE),
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
  // The Appearance, design and technical details settings it opens in, for its first paint (renderer/src/themes.ts,
  // design.ts, technical.ts); later picks reach it as they happen.
  const withAppearance = {
    ...query,
    [WINDOW_QUERY.appearance]: appearanceQuery(appearance.current()),
    [WINDOW_QUERY.design]: design.current(),
    [WINDOW_QUERY.technical]: String(technical.current()),
    [WINDOW_QUERY.dock]: dock.current(),
    // Tests read a terminal's text from the DOM renderer's rows, so their windows keep to it unless a test asks for
    // the GPU (session/terminal-gpu.ts). Never in a packaged build.
    ...(!app.isPackaged && process.env.AGENT_BOARD_TERMINAL_RENDERER === 'dom' ? { terminalRenderer: 'dom' } : {}),
  };
  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}?${new URLSearchParams(withAppearance)}`);
  } else {
    void window.loadFile(rendererFile, { query: withAppearance });
  }
  return window;
}

/** The board's window, while it is open. Popped-out session windows are not boards. */
let board: BrowserWindow | undefined;

/** The board's window, if it is open and not on its way out. */
function liveBoard(): BrowserWindow | undefined {
  return board !== undefined && !board.isDestroyed() ? board : undefined;
}

/** Brings the board's window forward, shown, restored and focused, opening it first if none is open. */
function showBoard(): BrowserWindow {
  const window = openBoard();
  revealWindow(window);
  return window;
}

/** Opens the board, with `showing`'s window shown on it, and returns its window. With a board already open, returns that and ignores `showing`. */
function openBoard(showing?: WindowTarget): BrowserWindow {
  // The app has one board. Whatever asks while it is open gets it back, never a second window.
  const open = liveBoard();
  if (open !== undefined) return open;
  // Benchmarks fill the board with placeholder tiles and sticky notes (see e2e/board-perf.spec.ts). Never in a packaged build.
  const placeholders = app.isPackaged ? undefined : process.env.AGENT_BOARD_PLACEHOLDER_TILES;
  const stickies = app.isPackaged ? undefined : process.env.AGENT_BOARD_PLACEHOLDER_STICKIES;
  // Turns on keeping terminals while off screen (session/kept-terminals.ts) with this many bytes, for benchmarks and tests.
  const terminalCache = app.isPackaged ? undefined : process.env.AGENT_BOARD_TERMINAL_CACHE;
  const window = openWindow(
    {
      // Tests keep onboarding from opening by itself on their empty boards, packaged or not; onboarding.spec.ts opts in.
      ...(process.env.AGENT_BOARD_ONBOARDING === '0' ? { onboarding: 'off' } : {}),
      ...(placeholders ? { placeholders } : {}),
      ...(stickies ? { stickies } : {}),
      ...(terminalCache ? { terminalCache } : {}),
      // The renderer reads demo mode from here alone, so a packaged build, where `demo` is never set, can't reach it.
      ...(demo ? { [WINDOW_QUERY.demo]: '1' } : {}),
      ...(showing ? { [WINDOW_QUERY.show]: showing.id, [WINDOW_QUERY.kind]: showing.kind, [WINDOW_QUERY.title]: showing.title } : {}),
    },
    demo ? { offscreenScale: DEMO_SCALE } : testScale !== undefined ? { offscreenScale: testScale } : {},
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
// Web tabs keep logins in a shared session while Settings says to, read as each opens. Turned off, the pages in it move
// to sessions of their own and it is emptied, once, not again at every other setting's change while it stays off; and
// emptied as the app connects while it is off, should anything have been left in it.
let keptWebLogins: boolean | undefined;
// A headless test can't use a real full screen, which shows the window and takes a Space (background.ts), so it sets
// this variable in the main process to have the board count as full screen. Never in a packaged build.
const boardFullScreen = (window: BrowserWindow) => window.isFullScreen() || (!app.isPackaged && process.env.AGENT_BOARD_TEST_FULL_SCREEN === '1');
const settingsWindow = registerSettingsWindow({ open: openWindow, board: liveBoard, isFullScreen: boardFullScreen });
/** "Extended keyboard shortcuts", as the windows last saved it: read once the view state is up, then followed. */
let extendedShortcuts = true;
/** The presses web pages kept, which the menu bar's accelerators drop. */
const pageKept = pageKeys(process.platform === 'darwin');
const webTabs = registerWebTabIpc({
  isBoard: (contents) => board !== undefined && !board.isDestroyed() && board.webContents === contents,
  isSettings: settingsWindow.isSettings,
  keepLogins: async () => (await daemon.call('settings.get')).keepWebLogins,
  // Read as a key is pressed, after `design` is registered below.
  simplified: () => design.current() === 'simplified',
  extended: () => extendedShortcuts,
  pageKept: (owner, input) => pageKept.kept(owner.id, input),
});
const followKeepLogins = (keep: boolean) => {
  if (!keep && keptWebLogins !== false) {
    webTabs.stopKeepingLogins();
    void clearWebLogins().catch(() => {});
  }
  keptWebLogins = keep;
};
daemon.onEvent((event) => {
  if (event.type === 'settings.updated') followKeepLogins(event.settings.keepWebLogins);
});
daemon.onConnected(() => {
  daemon.call('settings.get').then(
    (settings) => followKeepLogins(settings.keepWebLogins),
    () => {},
  );
});
registerOrchestratorIpc(daemon);
registerAgentIpc(daemon, dataDir);
registerShellIpc(daemon);
registerExternalIpc(daemon);
registerTrackerIpc(daemon);
const isSimplified = () => design.current() === 'simplified';
const notify = createNotifier(isSimplified);
registerSetupIpc(daemon, notify);
// Before any window opens. Tests pin the theme with AGENT_BOARD_APPEARANCE, the default when nothing was picked, so a
// machine in dark mode doesn't change their screenshots.
const appearance = registerAppearance(dataDir, appearanceFrom(process.env.AGENT_BOARD_APPEARANCE));
const design = registerDesign(dataDir);
const technical = registerTechnical(dataDir);
const dock = registerDock(dataDir);
const view = daemonViewState(daemon);
const overviewWindow = registerOverviewWindow({
  open: openWindow,
  board: liveBoard,
  view,
  isFullScreen: boardFullScreen,
});
registerViewIpc(view, (key, value) => {
  if (key === VIEW_KEYS.extendedShortcuts) extendedShortcuts = value !== false;
});
view.get(VIEW_KEYS.extendedShortcuts).then(
  (saved) => (extendedShortcuts = saved !== false),
  () => {},
);
const poppedWindows = registerWindowIpc({
  open: openWindow,
  view,
  board: liveBoard,
  openBoard,
});
// Pictures of zones for orchestrators, each in a hidden board window framed on its zone.
registerCaptures({
  daemon,
  served: () => view.remeasure(),
  openBoard: (frame) => openWindow({ [CAPTURE_QUERY]: JSON.stringify(frame), onboarding: 'off' }, { ...captureSize(frame), hidden: true }),
});
if (demo) registerDemoCapture(liveBoard);
registerTabDragIpc({ board: liveBoard, openBoard: () => openBoard(), poppedOwner: poppedWindows.poppedOwner });
const openAgent = registerAgentOpening(() => openBoard());

let stopNotifications: (() => void) | undefined;

app.on('second-instance', () => {
  if (app.isReady()) showBoard();
});

void app.whenReady().then(() => {
  registerImageProtocol(dataDir);
  const openFromNotification = (sessionId: string) => {
    traceNotificationClick(daemonPaths(dataDir).log, sessionId, liveBoard(), BrowserWindow.getAllWindows().length);
    openAgent(sessionId);
  };
  stopNotifications = registerNotifications(daemon, notify, openFromNotification, showBoard, isSimplified);
  setAppMenu(() => openBoard(), { settings: () => settingsWindow.show(), overview: () => overviewWindow.show() }, { design, technical }, { liveBoard, openBoard }, pageKept);
  // Start (or find) the daemon at launch, not when the window first asks.
  daemon.call('daemon.health').catch((error: unknown) => console.error('agent-board: could not reach the daemon:', error));
  openBoard();
  // A popped-out session window may still be open: the board comes back whenever it is missing.
  app.on('activate', () => {
    openBoard();
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
