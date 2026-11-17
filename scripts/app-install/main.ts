// The last step of `pnpm package`: installs the app it just built, as ~/Applications/agent-board.app on macOS, or on
// Debian and Ubuntu from its .deb, in /opt/agent-board. `pnpm package --no-install` builds only.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { packagedApp } from '../../apps/desktop/e2e/packaged-app.ts';
import { appRunning, BUNDLE_ID, installBuilt, quitInstalledApp, shouldInstall } from './app-install.ts';
import { installDeb, linuxMachine, linuxPackages } from './linux-install.ts';

const USAGE = `usage: pnpm package [--no-install] [--install-dir <dir>] [--open | --no-open]

Builds the app, then installs it as ~/Applications/agent-board.app, replacing the old copy. On Linux it builds a .deb
and a tar.gz, and on Debian or Ubuntu installs the .deb with apt (through sudo), in /opt/agent-board.
If the app is running it is quit first (your sessions live in the daemon and keep running), and you are asked whether to reopen it.
  --no-install   build only: leave the app in apps/desktop/dist
  --install-dir  where to install the app (default: ~/Applications; macOS only)
  --open         open the app afterwards without asking
  --no-open      never reopen the app, and don't ask`;

let parsed;
try {
  parsed = parseArgs({
    // `pnpm package -- --no-install` hands over a leading `--`, which would make the flags after it positional.
    args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--')),
    options: {
      'no-install': { type: 'boolean', default: false },
      'install-dir': { type: 'string' },
      install: { type: 'boolean', default: false },
      'opt-in': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}

const { values, positionals } = parsed;
if (positionals.length > 0) {
  console.error(`unexpected argument ${positionals[0]}\n\n${USAGE}`);
  process.exit(2);
}

const desktopDir = resolve(import.meta.dirname, '../../apps/desktop');
const log = (message: string) => console.log(`package: ${message}`);
const confirm = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n(o)?$/i.test((await prompt.question(`${question} [Y/n] `)).trim());
  } finally {
    prompt.close();
  }
};

async function install(): Promise<void> {
  if (process.platform === 'linux') {
    if (values['install-dir'] !== undefined) throw new Error('--install-dir is macOS only: on Linux the .deb installs in /opt/agent-board');
    await installDeb({ ...linuxPackages(desktopDir), open: values.open, noOpen: values['no-open'], confirm, log }, linuxMachine);
    return;
  }
  await installBuilt(
    {
      builtApp: packagedApp(desktopDir),
      // Relative paths are from where the command was typed: pnpm says where in INIT_CWD.
      installDir: resolve(process.env.INIT_CWD ?? process.cwd(), values['install-dir'] ?? join(homedir(), 'Applications')),
      open: values.open,
      noOpen: values['no-open'],
      confirm,
      log,
    },
    {
      running: () => appRunning(BUNDLE_ID),
      quit: () => quitInstalledApp(BUNDLE_ID),
      open: (path) => void execFileSync('open', [path]),
      sleep: (ms) => sleep(ms),
    },
  );
}

if (values.help) {
  console.log(USAGE);
} else if (!shouldInstall({ noInstall: values['no-install'], install: values.install, optIn: values['opt-in'] })) {
  log('built; not installing the app (pass --install to install it). It is in apps/desktop/dist.');
} else if (process.platform !== 'darwin' && process.platform !== 'linux') {
  log(`installing the app is for macOS and Linux, so it was not installed on ${process.platform}. The build is in apps/desktop/dist.`);
} else {
  try {
    await install();
  } catch (error) {
    console.error(`package: ${(error as Error).message}`);
    process.exit(1);
  }
}
