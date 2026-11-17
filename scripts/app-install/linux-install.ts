// Installing the packaged Linux app: the last step of `pnpm package` on Linux. electron-builder has made a .deb and a
// tar.gz (apps/desktop/electron-builder.yml); on Debian and Ubuntu the .deb is installed with apt, as /opt/agent-board.
// Node built-ins only, so it runs before anything is installed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { offerReopen, type InstallBuiltOptions } from './app-install.ts';
import { type AppControl, quitAndWait } from './quit-and-wait.ts';

/** Where the .deb installs the app (/opt/<productName>), and its executable in it (`executableName`). */
const DEB_DIR = '/opt/agent-board';
export const DEB_EXECUTABLE = `${DEB_DIR}/agent-board`;

/** Whether apt is here to install a .deb with: Debian, Ubuntu and their kin. */
export const hasApt = (): boolean => spawnSync('apt-get', ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * electron-builder's target flags for `pnpm package` on this machine: none, so the config's targets are built, except on
 * Linux without apt. There only the tar.gz is built: nothing would install a .deb, and making one needs tools such
 * machines may lack.
 */
export function builderTargetArgs(platform: NodeJS.Platform, apt: boolean): string[] {
  return platform === 'linux' && !apt ? ['--linux', 'tar.gz'] : [];
}

/**
 * The tar.gz and the .deb electron-builder left in `<desktopDir>/dist`. Packaging empties dist/ first, so there is one
 * of each, or no .deb where only the tar.gz was built.
 */
export function linuxPackages(desktopDir: string): { deb: string | undefined; tarball: string } {
  const dist = join(desktopDir, 'dist');
  const files = existsSync(dist) ? readdirSync(dist) : [];
  const atMostOne = (ext: string): string | undefined => {
    const found = files.filter((file) => file.startsWith('agent-board-') && file.endsWith(ext));
    if (found.length > 1) throw new Error(`more than one ${ext} in ${dist} (${found.join(', ')}): run \`pnpm package\` again`);
    return found[0] === undefined ? undefined : join(dist, found[0]);
  };
  const tarball = atMostOne('.tar.gz');
  if (tarball === undefined) throw new Error(`no .tar.gz in ${dist}: run \`pnpm package\` on Linux first`);
  return { deb: atMostOne('.deb'), tarball };
}

/** One process, as /proc shows it: the program it runs, its arguments and its environment. */
export interface LinuxProcess {
  pid: number;
  exe: string;
  args: string[];
  env: string[];
}

/**
 * The processes of the user whose real uid is `uid`, from `procDir`. Another user's are left out even where they can be
 * read, so quitting the app never signals someone else's; so are ones it may not read or that ended meanwhile.
 */
export function linuxProcesses(procDir = '/proc', uid = process.getuid?.()): LinuxProcess[] {
  const nulSplit = (path: string) => readFileSync(path, 'utf8').split('\0').filter((part) => part !== '');
  const processes: LinuxProcess[] = [];
  for (const entry of readdirSync(procDir)) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = join(procDir, entry);
    try {
      if (realUid(readFileSync(join(dir, 'status'), 'utf8')) !== uid) continue;
      processes.push({ pid: Number(entry), exe: readlinkSync(join(dir, 'exe')), args: nulSplit(join(dir, 'cmdline')).slice(1), env: nulSplit(join(dir, 'environ')) });
    } catch {
      // Not ours to read, or gone.
    }
  }
  return processes;
}

/** The real uid on the `Uid:` line of a /proc/<pid>/status (real, effective, saved, filesystem), if there is one. */
function realUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether `proc` is the app's own main process, run from `executable`. The same executable also runs Chromium's helpers
 * (with a `--type=` argument), and the daemon and the hook forwarder (as Node, with ELECTRON_RUN_AS_NODE set): those are
 * left alone, so quitting the app never stops the daemon or its sessions.
 */
export function isAppMain(proc: LinuxProcess, executable: string): boolean {
  return proc.exe === executable && !proc.args.some((arg) => arg.startsWith('--type=')) && !proc.env.some((entry) => /^ELECTRON_RUN_AS_NODE=./.test(entry));
}

/** The command that installs `deb` with apt: through sudo unless this already runs as root. `--reinstall`, since every build is version 0.0.0. */
export function aptInstallCommand(deb: string, uid: number): { command: string; args: string[] } {
  const apt = ['apt-get', 'install', '--reinstall', '-y', deb];
  return uid === 0 ? { command: apt[0]!, args: apt.slice(1) } : { command: 'sudo', args: apt };
}

export interface LinuxMachine extends AppControl {
  /** Whether apt is here to install a .deb with: Debian, Ubuntu and their kin. */
  hasApt(): boolean;
  /** Who ran this through sudo, when it runs as root because of sudo. */
  sudoUser(): string | undefined;
  /** Installs the .deb, throwing if it fails. */
  install(deb: string): void;
  /** Opens the installed app. */
  open(): void;
}

export type InstallDebOptions = Pick<InstallBuiltOptions, 'open' | 'noOpen' | 'confirm' | 'log'> & { deb: string | undefined; tarball: string };

/**
 * Installs a finished build's .deb over the installed app: quits the app if it is running, installs, and offers to reopen
 * it, as on macOS. If the install fails, the app the machine had is reopened. Without apt it installs nothing and says
 * what was built. Under sudo it refuses before touching anything, since the app it reopened would run as root. Resolves
 * with whether it installed.
 */
export async function installDeb(options: InstallDebOptions, machine: LinuxMachine): Promise<boolean> {
  const { log, deb } = options;
  if (!machine.hasApt()) {
    log(`Built ${options.tarball}. There is no apt here to install a .deb with, so nothing was installed: unpack the tar.gz anywhere and run agent-board in it.`);
    return false;
  }
  if (deb === undefined) throw new Error(`no .deb beside ${options.tarball}: run \`pnpm package\` again`);
  const sudoUser = machine.sudoUser();
  if (sudoUser !== undefined) {
    throw new Error(`run \`pnpm package\` as ${sudoUser}, not through sudo: it asks for sudo itself for the apt step, and the app must not run as root. Nothing was installed.`);
  }
  const wasRunning = machine.running();
  await quitAndWait(machine, log);
  log(`Installing ${deb} with apt (sudo may ask for your password).`);
  try {
    machine.install(deb);
  } catch (error) {
    if (wasRunning) {
      machine.open();
      log('The install failed; reopened the app you had.');
    }
    throw error;
  }
  log(`Installed agent-board in ${DEB_DIR}; \`agent-board\` opens it.`);
  await offerReopen(options, wasRunning, () => machine.open(), 'Open it from your app menu, or run `agent-board`,');
  return true;
}

/** The real machine: /proc, SIGTERM (Electron quits cleanly on it), apt, and the installed executable. */
export const linuxMachine: LinuxMachine = {
  running: () => linuxProcesses().some((proc) => isAppMain(proc, DEB_EXECUTABLE)),
  quit() {
    for (const proc of linuxProcesses()) if (isAppMain(proc, DEB_EXECUTABLE)) process.kill(proc.pid, 'SIGTERM');
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  hasApt,
  sudoUser: () => (process.getuid?.() === 0 && process.env.SUDO_USER ? process.env.SUDO_USER : undefined),
  install(deb) {
    const { command, args } = aptInstallCommand(deb, process.getuid?.() ?? -1);
    const { status, error } = spawnSync(command, args, { stdio: 'inherit' });
    if (error) throw new Error(`could not run ${command}: ${error.message}`);
    if (status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${status})`);
  },
  open() {
    launch(DEB_EXECUTABLE, (error) => {
      console.error(`package: could not open ${DEB_EXECUTABLE}: ${error.message}`);
      process.exitCode = 1;
    });
  },
};

/** Starts `executable` on its own, so it outlives this command. A failure to start (no such file) goes to `onError`. */
export function launch(executable: string, onError: (error: Error) => void): void {
  // Not as Node: pnpm's environment may carry ELECTRON_RUN_AS_NODE from a terminal in an Electron editor.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', env });
  child.on('error', onError);
  child.unref();
}
