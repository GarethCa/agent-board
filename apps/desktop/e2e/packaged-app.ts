import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_NAME = 'agent-board.app';
const EXECUTABLE = 'agent-board';

/** The one entry of `found`, or an error saying what to do: packaging empties dist/ first, so more means a stale build. */
function only(found: string[], what: string, dist: string, fix: { none: string; many: string }): string {
  if (found.length !== 1) {
    throw new Error(found.length === 0 ? `no ${what} in ${dist}: ${fix.none}` : `more than one ${what} in ${dist} (${found.join(', ')}): ${fix.many}`);
  }
  return found[0]!;
}

function distDirs(dist: string, prefix: string): string[] {
  return existsSync(dist) ? readdirSync(dist).filter((dir) => dir.startsWith(prefix)) : [];
}

/**
 * The .app `pnpm package` left in `<desktopDir>/dist`: `mac-arm64/` or `mac/`, by architecture. Packaging empties
 * dist/ first, so there is exactly one; more means a stale build, and this throws rather than guess.
 */
export function packagedApp(desktopDir: string): string {
  const dist = join(desktopDir, 'dist');
  const apps = distDirs(dist, 'mac')
    .map((dir) => join(dist, dir, APP_NAME))
    .filter((path) => existsSync(path));
  return only(apps, APP_NAME, dist, { none: 'run `pnpm package` first', many: 'run `pnpm package` again' });
}

/**
 * The packaged app's executable: the .app's binary on macOS, or on Linux the binary in the unpacked build that
 * electron-builder leaves in `dist/linux-unpacked/` (`linux-arm64-unpacked/` on arm64) when it runs on Linux. To test an
 * installed copy instead, such as a .deb's `/opt/agent-board/agent-board`, set `PACKAGED_EXECUTABLE`.
 */
export function packagedExecutable(desktopDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return join(packagedApp(desktopDir), 'Contents', 'MacOS', EXECUTABLE);
  const dist = join(desktopDir, 'dist');
  const executables = distDirs(dist, 'linux')
    .filter((dir) => dir.endsWith('-unpacked'))
    .map((dir) => join(dist, dir, EXECUTABLE))
    .filter((path) => existsSync(path));
  const installed = 'or set PACKAGED_EXECUTABLE to an installed agent-board';
  return only(executables, `${EXECUTABLE} executable`, dist, {
    none: `build it on Linux with \`npx electron-builder --linux\` in apps/desktop, ${installed}`,
    many: `remove the stale one, ${installed}`,
  });
}

const ROSETTA = '/run/rosetta/rosetta';

/**
 * The program a Linux process runs: its `/proc/<pid>/exe`, unless that is Rosetta (Docker Desktop runs amd64 containers
 * through it on a Mac). Then it is argv[0] in `/proc/<pid>/cmdline` (NUL-separated), which Docker Desktop keeps as the
 * program, or argv[1] where binfmt puts the interpreter first.
 */
export function linuxProgram(exe: string, cmdline: () => string): string {
  if (exe !== ROSETTA) return exe;
  const argv = cmdline().split('\0');
  return (argv[0] === ROSETTA ? argv[1] : argv[0]) ?? '';
}
