import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageScripts } from './protocol.ts';

/** Each package manager by the lockfile that gives it away, the first found winning; npm without one. */
const LOCKFILES: [string, PackageScripts['runner']][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

/** The folder's `package.json` scripts, in its order, and what runs them. None for a folder without one, or with one that isn't JSON. */
export function packageScripts(folder: string): PackageScripts {
  const runner = LOCKFILES.find(([file]) => existsSync(join(folder, file)))?.[1] ?? 'npm';
  let scripts: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: unknown };
    if (typeof manifest.scripts === 'object' && manifest.scripts !== null) scripts = Object.keys(manifest.scripts);
  } catch {
    // No package.json, or not one that can be read: no scripts.
  }
  return { runner, scripts };
}

/** The command line that runs the script, as typed at a shell's prompt. */
export const scriptCommand = (runner: PackageScripts['runner'], script: string): string => `${runner} run ${shellQuote(script)}`;

/** A script's name as one shell word: bare when it is plain, else single-quoted. */
function shellQuote(word: string): string {
  return /^[\w:.@/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
