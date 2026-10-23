/**
 * `pnpm check:pr`: the per-PR gate. Looks at what the branch changed against origin/main, prints which checks it chose and
 * why, and runs just those, in parallel where they don't depend on each other. A change to the gate, the shared config,
 * the e2e helpers, the fake CLIs or the protocol runs the full `check:local` instead. Rules: select.ts.
 *
 *   node scripts/check-pr/main.ts [--dry-run] [--base <ref>]
 *
 * Run `git fetch origin` first so the diff is against the current main. --dry-run prints the plan and runs nothing. Exits non-zero if any step failed.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubBoardEnv } from '../../packages/fake-harness/src/board-guard.ts';
import { flakyTests } from '../e2e-flaky/flaky.ts';
import { acquireLock } from '../e2e-lock/lock.ts';
import { reapWorktree } from '../e2e-lock/reap.ts';
import { keepAwake, readBatteryNote, readSleeps, sleepNote } from '../machine-sleep/sleeps.ts';
import { selectChecks } from './select.ts';
import { leakCheckStep, stepsFor, type Step } from './steps.ts';
import { filesNamingTickets } from './ticket-ids.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baseIndex = args.indexOf('--base');
const baseArg = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
if (baseIndex >= 0 && !baseArg) {
  console.error('check:pr: --base needs a ref');
  process.exit(2);
}
const root = join(import.meta.dirname, '..', '..');
// Run from inside an agent on a live board, the steps would inherit its AGENT_BOARD_* and talk to that board.
scrubBoardEnv();
// A Mac that sleeps mid-run freezes the steps, and the tests wake to find their timeouts gone (scripts/machine-sleep).
if (!dryRun) keepAwake();

const git = (...a: string[]): string => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const lines = (text: string): string[] => text.split('\n').filter(Boolean);

function changedFiles(): { files: string[]; base: string } {
  const ref = baseArg ?? ['origin/main', 'main'].find((r) => { try { git('rev-parse', '--verify', '-q', r); return true; } catch { return false; } });
  if (!ref) throw new Error('check:pr: no origin/main or main to compare against; pass --base <ref>');
  const base = git('merge-base', ref, 'HEAD');
  const files = [
    ...lines(git('diff', '--name-only', `${base}...HEAD`)),
    ...lines(git('diff', '--name-only', 'HEAD')),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ];
  return { files: [...new Set(files)], base: `${ref} (${base.slice(0, 7)})` };
}

/**
 * Each step's wall-clock limit in minutes, as in check-local.sh: about three times a usual run on a loaded machine, and
 * more for the unit tests, which may run on one worker per project. Past it, scripts/deadline kills the step and
 * everything it started.
 */
const LIMIT_MIN: Record<string, number> = { unit: 45, visual: 10, e2e: 30 };
const limitOf = (step: Step): number => LIMIT_MIN[step.name] ?? 10;
/** scripts/deadline's exit status, and the start of the line it prints, for a step that ran past its limit. */
const TIMED_OUT = 124;
const DEADLINE_MARK = 'deadline: stage';

/** Signals a step and everything it started: each step leads its own process group, and its deadline passes the signal on to the command's. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
}

/** The step processes running now, which a signal to the gate must stop. */
const running = new Set<ChildProcess>();
/** The full gate's child (check-local.sh), which is not detached: Ctrl-C reaches it with the terminal, a plain kill needs forwarding. */
let fullGate: ChildProcess | undefined;
/** The machine-wide e2e lock, once this gate holds it. */
let heldLock: { release(): void } | undefined;

// Registered before the first step so Ctrl-C or kill stops every stage (the steps are detached from the terminal's group),
// and, when the lock is held, reaps what they started before the lock goes, so the next gate never overlaps a live run.
let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of running) killGroup(child, signal);
  if (fullGate?.pid !== undefined) { try { process.kill(fullGate.pid, signal); } catch { /* already gone */ } }
  if (heldLock !== undefined) {
    await reapWorktree(root, process.pid);
    heldLock.release();
  }
  process.exit(130);
}
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGHUP', () => void stop('SIGHUP'));

const reportOf = (step: Step, logDir: string): string => join(logDir, `${step.name}.json`);

/** The flaky tests of a Playwright step's run, none if it wrote no report. */
function flakyOf(step: Step, logDir: string): string[] {
  if (!step.playwright) return [];
  try {
    return flakyTests(JSON.parse(readFileSync(reportOf(step, logDir), 'utf8')));
  } catch {
    return [];
  }
}

function run(step: Step, logDir: string): Promise<{ name: string; outcome: string; seconds: number }> {
  const started = Date.now();
  const log = createWriteStream(join(logDir, `${step.name}.log`));
  return new Promise((resolve) => {
    const argv = [join(root, 'scripts', 'deadline', 'main.ts'), step.name, String(limitOf(step)), '--', ...step.argv];
    // A report left in a reused log dir by an earlier run would name its flaky tests as this run's.
    if (step.playwright) rmSync(reportOf(step, logDir), { force: true });
    const env = step.playwright ? { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportOf(step, logDir) } : process.env;
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    running.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    // A command can exit 124 on its own; only the deadline's own line means it ran over.
    let overLimit = false;
    child.stderr.on('data', (chunk: Buffer) => { overLimit ||= chunk.toString().includes(DEADLINE_MARK); });
    child.on('close', (code) => {
      running.delete(child);
      log.end();
      const outcome = code === 0 ? 'pass' : code === TIMED_OUT && overLimit ? `FAIL: over its ${limitOf(step)} min limit` : 'FAIL';
      console.log(`${step.name}: ${outcome} (log: ${join(logDir, `${step.name}.log`)})`);
      resolve({ name: step.name, outcome, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const { files, base } = changedFiles();
const plan = selectChecks(files, (file) => existsSync(join(root, file)));
const naming = filesNamingTickets(files, root);
const leakCheck = naming.length > 0;
plan.reasons.push(leakCheck ? `release-leaks: ${naming.length} changed file(s) name a ticket ID, so the release leak check runs` : 'release-leaks: skipped, no changed file names a ticket ID');
console.log(`check:pr: ${files.length} file(s) changed against ${base}`);
for (const reason of plan.reasons) console.log(`  ${reason}`);

if (plan.full) {
  console.log('check:pr: running the full gate, pnpm check:local');
  if (dryRun) process.exit(0);
  const logDir = process.env.CHECK_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'agent-board-check-pr.'));
  mkdirSync(logDir, { recursive: true });
  const leaks = leakCheck ? (await run(leakCheckStep, logDir)).outcome : 'pass';
  const full = spawn('sh', ['scripts/check-local.sh'], { cwd: root, stdio: 'inherit' });
  fullGate = full;
  full.on('close', (code) => process.exit(code || leaks !== 'pass' ? 1 : 0));
} else {
  const steps = stepsFor(plan, { leakCheck, exists: (file) => existsSync(join(root, file)), headless: process.platform === 'linux' && !process.env.DISPLAY });
  console.log(`check:pr: steps: ${steps.map((s) => s.name).join(', ')}`);
  if (dryRun) process.exit(0);
  const logDir = process.env.CHECK_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'agent-board-check-pr.'));
  mkdirSync(logDir, { recursive: true });
  const started = Date.now();
  const batteryAtStart = await readBatteryNote();
  if (batteryAtStart !== undefined) console.log(batteryAtStart);
  const results = new Map<string, { outcome: string; seconds: number }>();
  const settle = async (step: Step): Promise<void> => {
    const r = await run(step, logDir);
    results.set(r.name, r);
  };
  // Stages, as in check-local.sh; the heavy runs never overlap, because the unit tests (5-second timeouts) and the e2e fail
  // when starved. 1: lint, typecheck, markdownlint and the build. 2: unit. 3: the native visual run, then the e2e.
  const named = (...names: string[]): Step[] => steps.filter((s) => names.includes(s.name));
  await Promise.all(named('build', 'lint', 'typecheck', 'markdownlint', 'release-leaks').map(settle));
  await Promise.all(named('unit').map(settle));
  if ((results.get('build')?.outcome ?? 'pass') === 'pass') {
    // One Electron run at a time across the machine (scripts/e2e-lock): other gates queue, and this one reaps what its run left.
    const electronSteps = named('visual', 'e2e');
    if (electronSteps.length > 0) {
      const lock = await acquireLock({ step: electronSteps.map((s) => s.name).join('+'), worktree: root }).catch((error: Error) => {
        console.error(error.message);
        return undefined;
      });
      if (lock !== undefined) {
        heldLock = lock;
        try {
          await reapWorktree(root);
          for (const stage of [['visual'], ['e2e']]) await Promise.all(named(...stage).map(settle));
        } finally {
          await reapWorktree(root, process.pid);
          lock.release();
          heldLock = undefined;
        }
      } else {
        for (const step of electronSteps) results.set(step.name, { outcome: 'FAIL', seconds: 0 });
      }
    }
  }
  let failed = false;
  const rows: string[] = [];
  const flaky: string[] = [];
  for (const step of steps) {
    const r = results.get(step.name);
    if (!r) { rows.push(`| \`${step.name}\` | not run: the build failed | |`); failed = true; continue; }
    if (r.outcome !== 'pass') failed = true;
    const names = flakyOf(step, logDir);
    flaky.push(...names);
    rows.push(`| \`${step.name}\` | ${r.outcome}${names.length > 0 ? `, ${names.length} flaky` : ''} | ${r.seconds}s |`);
  }
  const dirty = git('status', '--porcelain').length > 0;
  console.log(`\nPer-PR checks on \`${git('rev-parse', '--short', 'HEAD')}\`${dirty ? ' (with uncommitted changes)' : ''}, ${Math.round((Date.now() - started) / 1000)}s wall:\n`);
  console.log(['| Step | Result | Time |', '| --- | --- | --- |', ...rows].join('\n'));
  if (flaky.length > 0) console.log(`\nFlaky, passed on a retry (fix them; they don't fail the gate):\n\n${flaky.map((name) => `- ${name}`).join('\n')}`);
  console.log('\nThis is the subset for this change, not the full gate; the master runs `pnpm check:local` on main after merge.');
  const slept = sleepNote(await readSleeps(new Date(started)), new Date(started), new Date());
  if (slept !== undefined) console.log(`\n${slept}`);
  // Read again: plugged in or unplugged since the start, the end is what the next run inherits.
  const batteryNow = await readBatteryNote();
  if (batteryNow !== undefined) console.log(`\n${batteryNow}`);
  writeFileSync(join(logDir, 'summary.md'), rows.join('\n'));
  process.exit(failed ? 1 : 0);
}
