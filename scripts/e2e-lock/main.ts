/**
 * Runs a command holding the machine-wide e2e lock, then reaps the test Electron processes it left in this worktree.
 *
 *   node scripts/e2e-lock/main.ts <step> -- <command> [args...]
 *
 * Exits with the command's status (1 when the lock wait timed out). Used by scripts/check-local.sh.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { acquireLock } from './lock.ts';
import { reapWorktree } from './reap.ts';

const root = join(import.meta.dirname, '..', '..');
const dash = process.argv.indexOf('--');
const step = process.argv[2];
if (dash < 3 || step === undefined || dash === process.argv.length - 1) {
  console.error('usage: node scripts/e2e-lock/main.ts <step> -- <command> [args...]');
  process.exit(2);
}
const [cmd, ...rest] = process.argv.slice(dash + 1);

const lock = await acquireLock({ step, worktree: root }).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
await reapWorktree(root);
const code = await new Promise<number>((resolve) => {
  const child = spawn(cmd!, rest, { stdio: 'inherit', detached: true });
  // The command leads its own process group, so a signal reaches everything it started.
  const forward = (signal: NodeJS.Signals) => () => {
    try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('close', (status, signal) => resolve(status ?? (signal === null ? 1 : 128)));
});
await reapWorktree(root, process.pid);
lock.release();
process.exit(code);
