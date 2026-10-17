import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { isProcessAlive } from '@agent-board/daemon/pid';
import { scrubBoardSessionEnv } from '@agent-board/fake-harness';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const appEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
/** `agent-board daemon`'s entry, which the app runs with its own executable as Node. */
export const daemonEntry = fileURLToPath(new URL('../out/main/daemon.js', import.meta.url));

/**
 * Keeps the app from activating itself, taking focus or switching Spaces while a developer works, and its windows off
 * the screen: they paint offscreen, so WindowServer does no work for them. `AGENT_BOARD_HEADED=1` in the environment of
 * the run shows them, to watch it (see CONTRIBUTING.md).
 */
export const BACKGROUND_ENV = { AGENT_BOARD_E2E_BACKGROUND: '1', AGENT_BOARD_HEADLESS: '1' };

/** Data dirs and apps the current test made, which the `test` fixture below reaps when it ends. */
const dataDirs = new Set<string>();
const apps = new Set<ElectronApplication>();
/** Data dirs of earlier tests in this worker that were reaped, for the spec that checks nothing was left behind. */
export const reapedDataDirs: string[] = [];

/** Where each worker lists the data dirs it makes, so the global teardown can check none of their daemons survived. */
function dataDirRegistry(): string | undefined {
  const runDir = process.env.AGENT_BOARD_DATA_DIR;
  return runDir === undefined ? undefined : join(runDir, 'e2e-data-dirs.txt');
}

/** Has the end of the test reap `dir` and any daemon serving it, and records it for the global teardown's check. */
function track(dir: string): void {
  if (dataDirs.has(dir)) return;
  dataDirs.add(dir);
  const registry = dataDirRegistry();
  if (registry !== undefined) appendFileSync(registry, `${dir}\n`);
}

export function tempDataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-')));
  track(dir);
  return dir;
}

/** The data dirs the workers of this run made, as recorded by `tempDataDir`. */
export function registeredDataDirs(runDir: string): string[] {
  try {
    return readFileSync(join(runDir, 'e2e-data-dirs.txt'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The pids of daemon processes still serving any of `dirs` (by the `--data-dir` on their command line). */
export function daemonsServing(dirs: readonly string[]): number[] {
  if (dirs.length === 0 || process.platform === 'win32') return [];
  const listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null || !/\bdaemon\b/.test(match[2]!)) continue;
    if (dirs.some((dir) => `${match[2]!} `.includes(`--data-dir ${dir} `))) pids.push(Number(match[1]));
  }
  return pids;
}

/** SIGTERM, so a daemon ends its sessions' processes as it shuts down; SIGKILL only for one that ignores it. */
export async function terminate(pids: readonly number[]): Promise<void> {
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  for (let waited = 0; pids.some(isProcessAlive) && waited < 5_000; waited += 50) await sleep(50);
  for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
}

/**
 * Closes the apps and stops the daemons of the test that just ended, deletes its data dirs, and throws if a daemon
 * still serves one of them. The daemon outlives its app by design (ADR-0002), so without this each test leaves one
 * running until the idle timeout, or for ever when it still holds a session.
 */
async function reapTest(): Promise<void> {
  for (const app of apps) await app.close().catch(() => {});
  apps.clear();
  const dirs = [...dataDirs];
  dataDirs.clear();
  for (const dir of dirs) await removeDataDir(dir);
  reapedDataDirs.push(...dirs);
  const left = daemonsServing(dirs);
  await terminate(left);
  if (left.length > 0) throw new Error(`daemon ${left.join(', ')} still ran after its test ended`);
}

/** Playwright's `test`, plus a teardown after every test that reaps what it launched (see `reapTest`). */
export const test = base.extend<{ reap: void }>({
  reap: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => {
      await use();
      await reapTest();
    },
    { auto: true },
  ],
});

/**
 * Launches the built app on `dataDir`, so it never touches the real app-data dir, a real daemon or the real Codex hook
 * shim, and never raises a real OS notification. `args` are extra Electron/Chromium switches, placed before the app.
 */
export function launchApp(dataDir: string, env: Record<string, string> = {}, args: string[] = []): Promise<ElectronApplication> {
  track(dataDir);
  const launched = electron.launch({
    args: [...args, appEntry],
    env: {
      // global-setup.ts scrubbed the run's env; this keeps a board's session variables out even if a spec set them.
      ...scrubBoardSessionEnv({ ...process.env }),
      AGENT_BOARD_DATA_DIR: dataDir,
      AGENT_BOARD_HOOK_SHIM: join(dataDir, 'bin', 'agent-board-hook'),
      // Notifications are recorded in the main process (see notifications.spec.ts), never shown by the OS.
      AGENT_BOARD_FAKE_NOTIFICATIONS: '1',
      // Light unless a test picks otherwise: the developer's macOS may be in dark mode (main/appearance.ts).
      AGENT_BOARD_APPEARANCE: 'light',
      ...BACKGROUND_ENV,
      ...env,
    },
  });
  void launched.then((app) => apps.add(app), () => {});
  return launched;
}

/** Waits until the window shows a connected daemon, and returns that daemon's pid. */
export async function connectedDaemonPid(window: Page): Promise<number> {
  const status = window.getByTestId('daemon-status');
  await expect(status).toHaveAttribute('data-state', 'connected');
  return Number(await status.getAttribute('data-pid'));
}

/**
 * Stops the daemon the app left running in `dataDir` (it outlives the app by design) and waits for it to exit.
 * Returns its pid, or undefined if none was answering. The pid comes from the daemon itself over its socket, never
 * from the lock file, so a stale lock can't make us signal an unrelated process. Call it only after the app reported
 * a connected daemon, so no daemon is still booting.
 */
export async function stopDaemon(dataDir: string): Promise<number | undefined> {
  const { socket } = daemonPaths(dataDir);
  if (!existsSync(socket)) return undefined;
  let pid: number;
  try {
    const client = await connectDaemon(socket);
    pid = (await client.call('daemon.health')).pid;
    client.close();
  } catch {
    return undefined; // not answering: nothing running to stop
  }
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; isProcessAlive(pid) && waited < 5_000; waited += 50) await sleep(50);
  if (isProcessAlive(pid)) throw new Error(`daemon ${pid} did not exit after SIGTERM`);
  return pid;
}

/** Stops any daemon left in `dataDir`, then deletes the dir. */
export async function removeDataDir(dataDir: string): Promise<void> {
  await stopDaemon(dataDir).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

/**
 * Adds a zone for the folder `pickFolderNext` set, through Add zone's File browser tab: opened from the board menu, so the
 * zone lands in the middle of the view, clear of the others. Resolves once the popover has closed.
 */
export async function browseForZone(page: Page): Promise<void> {
  const popover = await openAddZone(page, 'File browser');
  await popover.getByRole('button', { name: 'Choose a folder…' }).click();
  await popover.getByRole('button', { name: /^Add zone/ }).click();
  await expect(popover).toBeHidden();
}

/** Opens Add zone from the board menu, on the tab named `tab`; resolves with the popover. */
export async function openAddZone(page: Page, tab: 'Group' | 'GitHub' | 'Linear' | 'Recent' | 'File browser') {
  await page.getByRole('button', { name: 'Board menu' }).click();
  await page.getByRole('button', { name: 'Add a zone' }).click();
  const popover = page.getByRole('dialog', { name: 'Add zone' });
  await popover.getByRole('tab', { name: tab }).click();
  return popover;
}

/** Adds a group (an unbound zone) called `name` through Add zone's Group tab, in the colour named `color` if given. */
export async function addEmptyZone(page: Page, name: string, color?: string): Promise<void> {
  const popover = await openAddZone(page, 'Group');
  await popover.getByRole('textbox', { name: 'Zone name' }).fill(name);
  if (color !== undefined) await popover.getByRole('radio', { name: color }).check();
  await popover.getByRole('button', { name: /^Add zone/ }).click();
  await expect(popover).toBeHidden();
}

/**
 * Puts a new agent or shell on the board with the toolbar's tool: arms it, then clicks the board at
 * `at` (relative to the board), near its top left by default.
 */
export async function placeWithTool(page: Page, tool: 'New agent' | 'New shell', at?: { x: number; y: number }): Promise<void> {
  await page.getByRole('button', { name: tool, exact: true }).click();
  // Clear of the islands at the board's corners, and of the empty board's welcome in its middle.
  await page.getByTestId('board-tool').click({ position: at ?? { x: 240, y: 240 } });
}

/** Puts a new shell loose in the middle of the board with the Shell tool. */
export async function newShell(page: Page): Promise<void> {
  await placeWithTool(page, 'New shell');
}

/** Makes the next folder picker in the app's main process return `path`, as if the user had picked it. */
export async function pickFolderNext(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
}
