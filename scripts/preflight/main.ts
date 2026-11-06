/**
 * The gate's pre-flight (preflight.ts), the first step of `check:local` and `check:pr`: about a second, so a merge
 * conflict, a left conflict marker or a clashing migration number fails at once instead of near the end of the full run.
 *
 *   node scripts/preflight/main.ts [--base <ref>]
 *
 * The base defaults to origin/main, or main when there is no origin/main. Run `git fetch origin` first to check against
 * the current main. Exits 1 if anything is wrong.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { preflight } from './preflight.ts';

const root = join(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
if (baseIndex >= 0 && !args[baseIndex + 1]) {
  console.error('preflight: --base needs a ref');
  process.exit(2);
}

const exists = (ref: string): boolean => {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const base = baseIndex >= 0 ? args[baseIndex + 1] : ['origin/main', 'main'].find(exists);

const started = Date.now();
let result: ReturnType<typeof preflight>;
try {
  result = preflight(root, base);
} catch (error) {
  // An unexpected git failure: a FAIL line the gate's log shows plainly, not a stack.
  console.error(`preflight: FAIL: ${(error as Error).message.split('\n')[0]}`);
  process.exit(1);
}
const { problems, notes } = result;
for (const note of notes) console.log(`preflight: ${note}`);
for (const problem of problems) console.error(`preflight: FAIL: ${problem}`);
console.log(`preflight: ${problems.length === 0 ? 'pass' : `${problems.length} problem(s)`} in ${Date.now() - started} ms`);
process.exit(problems.length === 0 ? 0 : 1);
