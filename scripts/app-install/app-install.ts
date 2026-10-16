// Installing the packaged macOS app, shared by the scripts that put a fresh build in ~/Applications.
// Node built-ins only, so it runs before anything is installed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type AppControl, quitAndWait } from './quit-and-wait.ts';

export const APP_NAME = 'agent-board.app';
/** The packaged app's bundle id (apps/desktop/electron-builder.yml). */
export const BUNDLE_ID = 'io.github.garethca.agent-board';

const stagingPath = (installDir: string) => join(installDir, `.${APP_NAME}.installing`);
const previousPath = (installDir: string) => join(installDir, `.${APP_NAME}.previous`);

/**
 * Copies the built app beside the installed one, ready for `swapIn`. Touches the installed app only to put it back: a
 * run that died between `swapIn`'s two renames left it as `.previous`, the only copy, and it is restored if
 * the installed app is missing.
 */
export function stageApp(builtApp: string, installDir: string): string {
  mkdirSync(installDir, { recursive: true });
  const target = join(installDir, APP_NAME);
  if (existsSync(previousPath(installDir))) {
    if (existsSync(target)) rmSync(previousPath(installDir), { recursive: true, force: true });
    else renameSync(previousPath(installDir), target);
  }
  const staging = stagingPath(installDir);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(builtApp, staging, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return staging;
}

/** Replaces the installed app with a staged copy: the old one is moved aside, and put back if the swap fails. */
export function swapIn(installDir: string): string {
  const target = join(installDir, APP_NAME);
  const staging = stagingPath(installDir);
  const previous = previousPath(installDir);
  const hadPrevious = existsSync(target);
  try {
    if (hadPrevious) renameSync(target, previous);
    renameSync(staging, target);
  } catch (error) {
    try {
      if (hadPrevious && existsSync(previous) && !existsSync(target)) renameSync(previous, target);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `could not install, and could not restore the old app, which is at ${previous}`, { cause: restoreError });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  return target;
}

/**
 * Copies the built app into `installDir`, replacing the previous build. The copy is made beside the old app first, and
 * the old app is only moved aside once it is complete, so a failure at any point leaves the previous app in place.
 */
export function installApp(builtApp: string, installDir: string): string {
  stageApp(builtApp, installDir);
  return swapIn(installDir);
}

/** Whether `pnpm package` installs. The dev repo's package script passes `--opt-in`, so there it takes an explicit `--install`. */
export function shouldInstall(flags: { noInstall: boolean; install: boolean; optIn: boolean }): boolean {
  return !flags.noInstall && (flags.install || !flags.optIn);
}
/**
 * Whether the app with `bundleId` is running. AppleScript can't resolve a bundle id LaunchServices has never seen
 * (error -1728), as on a Mac where agent-board was never installed; such an app can't be running.
 */
export function appRunning(bundleId: string): boolean {
  try {
    return osascript(`application id "${bundleId}" is running`) === 'true';
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes('(-1728)')) return false;
    throw error;
  }
}

/** Asks the running app to quit. */
export function quitInstalledApp(bundleId: string): void {
  osascript(`tell application id "${bundleId}" to quit`);
}

function osascript(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface InstallBuiltOptions {
  /** The freshly built `.app`. */
  builtApp: string;
  installDir: string;
  /** Reopen the app whether or not it was running. */
  open: boolean;
  /** Never reopen it, and never ask. */
  noOpen?: boolean;
  confirm(question: string): Promise<boolean>;
  log(message: string): void;
}

/**
 * Puts a finished build in place of the installed app: copies it beside the old one, quits the app if it is running,
 * swaps the copies, and offers to reopen it. Run only after the build succeeded, so a failed build never touches the
 * working app; a copy that fails does so before the quit. If the swap fails after the quit, the old app is reopened.
 * Resolves with the installed path.
 */
export async function installBuilt(options: InstallBuiltOptions, app: AppControl & { open(path: string): void }): Promise<string> {
  const { log } = options;
  const target = join(options.installDir, APP_NAME);
  const replaced = existsSync(target);
  stageApp(options.builtApp, options.installDir);
  const wasRunning = app.running();
  await quitAndWait(app, log);
  try {
    swapIn(options.installDir);
  } catch (error) {
    if (wasRunning && existsSync(target)) {
      app.open(target);
      log('The install failed; reopened the app you had.');
    }
    throw error;
  }
  log(replaced ? `Replaced ${target} with the new build; the old copy is gone.` : `Installed ${target}.`);
  if (options.noOpen) {
    if (wasRunning) log('Left agent-board closed. Open it from Applications when you are ready; your sessions kept running in the daemon.');
  } else if (options.open || (wasRunning && (await options.confirm('agent-board was running. Reopen it?')))) {
    app.open(target);
    log('Opened agent-board. Your sessions kept running in the daemon.');
  } else if (wasRunning) {
    log('Left agent-board closed. Open it from Applications when you are ready; your sessions kept running in the daemon.');
  }
  return target;
}
