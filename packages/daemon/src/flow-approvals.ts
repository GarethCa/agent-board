import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FlowCommandPlan } from './protocol.ts';

/** The most files a plan hashes, and the biggest it reads: a plan names a script or two, not a tree. */
const MAX_PLAN_FILES = 5;
const MAX_PLAN_FILE_BYTES = 1024 * 1024;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * The package.json script a command runs, if it runs one: `pnpm check:local`, `pnpm run x`, `npm run x`, `npm test`,
 * `yarn x`, `bun run x`.
 */
export function scriptName(command: string): string | undefined {
  const [tool, first, second] = command.trim().split(/\s+/);
  if (tool === undefined || first === undefined) return undefined;
  if (!['pnpm', 'npm', 'yarn', 'bun'].includes(tool)) return undefined;
  if (first === 'run' || first === 'run-script') return second;
  if (tool === 'npm') return ['test', 'start', 'stop', 'restart'].includes(first) ? first : undefined;
  if (tool === 'bun') return undefined;
  return first.startsWith('-') ? undefined : first;
}

/** The worktree's package.json scripts, or none if it has no package.json it can read. */
async function scripts(worktree: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(resolve(worktree, 'package.json'), 'utf8')) as { scripts?: unknown };
    return typeof parsed.scripts === 'object' && parsed.scripts !== null ? (parsed.scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The files inside the worktree that `text` names by a relative path (`scripts/check-local.sh`), each once. */
async function namedFiles(text: string, worktree: string): Promise<string[]> {
  const root = await realpath(worktree).catch(() => worktree);
  const found: string[] = [];
  for (const word of text.split(/\s+/)) {
    const path = word.replace(/^['"]|['";]$/g, '');
    if (!/^\.{0,2}\/?[\w.-]+(\/[\w.-]+)*$/.test(path) || !/[/.]/.test(path) || isAbsolute(path)) continue;
    const real = await realpath(resolve(worktree, path)).catch(() => undefined);
    if (real === undefined) continue;
    const within = relative(root, real);
    if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
    const stats = await stat(real).catch(() => undefined);
    if (stats?.isFile() !== true || stats.size > MAX_PLAN_FILE_BYTES || found.includes(within)) continue;
    found.push(within);
    if (found.length === MAX_PLAN_FILES) break;
  }
  return found;
}

/**
 * What a gate's or script's `command` will run in `worktree`, as the user approves it: the command; the
 * package.json script it names, if it names one, as the worktree has it now; and each file inside the worktree the
 * command or that script names, by its hash. Its fingerprint changes when any of them does, so an approval no longer
 * covers it. It looks one step deep: what the named files call in turn is not covered.
 */
export async function commandPlan(command: string, worktree: string): Promise<FlowCommandPlan> {
  const lines = [command];
  const name = scriptName(command);
  const script = name === undefined ? undefined : (await scripts(worktree))[name];
  if (name !== undefined && typeof script === 'string') lines.push(`package.json "${name}": ${script}`);
  for (const file of await namedFiles(`${command} ${typeof script === 'string' ? script : ''}`, worktree)) {
    lines.push(`${file}: sha256 ${sha256(await readFile(resolve(worktree, file))).slice(0, 12)}`);
  }
  const shown = lines.join('\n');
  return { command, shown, fingerprint: sha256(shown) };
}
