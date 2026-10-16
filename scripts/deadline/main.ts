/**
 * Runs one gate stage under a wall-clock limit.
 *
 *   node scripts/deadline/main.ts <stage> <minutes> -- <command> [args...]
 *
 * The command leads its own process group. Past the limit the whole group gets SIGTERM, then SIGKILL five seconds
 * later, and this exits 124 after saying which stage ran over, on a line starting `deadline: stage` (the gates look for
 * both, as a command can exit 124 on its own). When the gate that started this is gone (a killed
 * shell, a closed pane), the group gets SIGKILL at once. Whatever the command leaves running in its group when it ends
 * is killed too. Otherwise exits with the command's status. Used by scripts/check-local.sh and scripts/check-pr.
 */
import { spawn } from 'node:child_process';
import { watchAncestors } from '../../packages/fake-harness/src/processes.ts';

const [stage, minutesArg, dash, cmd, ...rest] = process.argv.slice(2);
const minutes = Number(minutesArg);
if (stage === undefined || !(minutes > 0) || dash !== '--' || cmd === undefined) {
  console.error('usage: node scripts/deadline/main.ts <stage> <minutes> -- <command> [args...]');
  process.exit(2);
}

const TIMED_OUT = 124;
const DEADLINE_MARK = 'deadline: stage';
const GRACE_MS = 5_000;

// Before the command starts, so the gate above is known even if it is killed at once; and before the limit's timer, as
// watching takes one `ps` of the whole machine, which must not count against the stage.
const stopWatching = watchAncestors(() => {
  signalGroup('SIGKILL');
  process.exit(1);
});

const child = spawn(cmd, rest, { stdio: 'inherit', detached: true });
function signalGroup(signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
}

let timedOut = false;
const limit = setTimeout(() => {
  timedOut = true;
  console.error(`\n${DEADLINE_MARK} \`${stage}\` exceeded its ${minutes} min limit; stopping it and everything it started.`);
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), GRACE_MS).unref();
}, minutes * 60_000);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => signalGroup(signal));

child.on('error', (error) => {
  console.error(`deadline: could not start ${cmd}: ${error.message}`);
  process.exit(127);
});
child.on('exit', (status, signal) => {
  clearTimeout(limit);
  stopWatching();
  signalGroup('SIGKILL');
  process.exit(timedOut ? TIMED_OUT : (status ?? (signal === null ? 1 : 128)));
});
