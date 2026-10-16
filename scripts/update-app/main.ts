// Entry for `pnpm update:app` and scripts/update-app.sh.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { updateApp } from './update-app.ts';

const USAGE = `usage: pnpm update:app [--no-launch] [--force] [--install-dir <dir>]

Brings this checkout up to date (git pull --ff-only), builds the app and installs it as ~/Applications/agent-board.app.
It never runs on its own: you run it when you want the update. It quits the app, installs, and opens it again.
Your sessions live in the daemon, so they keep running; if the daemon is older than the app, the app offers to restart it.
  --no-launch    install without opening the app
  --force        build and install even if the installed app is already current
  --install-dir  where to install the app (default: ~/Applications)`;

function parse() {
  try {
    return parseArgs({
      // `pnpm update:app -- --force` hands over a leading `--`, which would make the flags after it positional.
      args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--')),
      options: {
        'no-launch': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'install-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
}

const values = parse();
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (process.platform !== 'darwin') {
  console.error('update:app installs a macOS app; it only runs on macOS.');
  process.exit(1);
}

try {
  await updateApp({
    repoDir: resolve(import.meta.dirname, '../..'),
    // Relative paths are from where the command was typed: pnpm runs scripts from the repo root, and says where in INIT_CWD.
    installDir: resolve(process.env.INIT_CWD ?? process.cwd(), values['install-dir'] ?? join(homedir(), 'Applications')),
    launch: !values['no-launch'],
    force: values.force,
    log: (message) => console.log(`update:app: ${message}`),
  });
} catch (error) {
  console.error(`update:app: ${(error as Error).message}`);
  process.exit(1);
}
