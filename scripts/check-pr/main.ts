/**
 * `pnpm check:pr`: the per-PR gate. Looks at what the branch changed against origin/main, prints which checks it chose and
 * why, and runs just those, in parallel where they don't depend on each other. A change to the gate, the shared config,
 * the e2e helpers, the fake CLIs or the protocol runs the full `check:local` instead. Rules: select.ts.
 *
 *   node scripts/check-pr/main.ts [--dry-run] [--quick] [--base <ref> | --recheck]
 *
 * --quick is the pre-merge command for an agent's branch: the static steps and the selected unit tests, never the build, e2e or visual
 * runs, and a short table. A change that needs the full gate runs every unit test instead.
 *
 * --recheck checks a fix to a failed full run: against that run's result record, not origin/main (recheck.ts).
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
import { releaseRulePaths, selectChecks } from './select.ts';
import { leakCheckStep, runStages, stepsFor, type Step } from './steps.ts';
import { filesNamingTickets } from './ticket-ids.ts';
import { resultsDir, writeRecord, type GateRecord } from '../gate-results/results.ts';
import { quickReport } from './quick.ts';
import { findRecord, recheckPlan } from './recheck.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baseIndex = args.indexOf('--base');
const baseArg = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
if (baseIndex >= 0 && !baseArg) {
  console.error('check:pr: --base needs a ref');
  process.exit(2);
}
const quick = args.includes('--quick');
const recheck = args.includes('--recheck');
if (quick && recheck) {
  console.error('check:pr: --quick and --recheck do not combine');
  process.exit(2);
}
if (recheck && baseArg !== undefined) {
  console.error('check:pr: --recheck compares against the last full run, so it takes no --base');
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
const LIMIT_MIN: Record<string, number> = { unit: 45, processes: 45, visual: 10, e2e: 30 };
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
      if (!quick) console.log(`${step.name}: ${outcome} (log: ${join(logDir, `${step.name}.log`)})`);
      resolve({ name: step.name, outcome, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

/** For --recheck: the nearest full run's record, and the files changed since its tree. */
function changedSinceRecord(): { files: string[]; base: string; record: GateRecord } {
  const found = findRecord(root, resultsDir());
  if (found === undefined) {
    console.error('check:pr: --recheck found no full-gate result in the last commits: run pnpm check:local first');
    process.exit(2);
  }
  const { record, behind } = found;
  const files = [
    ...lines(git('diff', '--name-only', record.tree, 'HEAD^{tree}')),
    ...lines(git('diff', '--name-only', 'HEAD')),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ];
  return { files: [...new Set(files)], base: `the full gate's run on ${record.sha.slice(0, 7)} (${behind === 0 ? 'this commit' : `${behind} commit(s) back`})`, record };
}

const startSha = git('rev-parse', 'HEAD');
const { files, base, record } = recheck ? changedSinceRecord() : { ...changedFiles(), record: undefined };
/** The release config's file names for the release rules test; a checkout without the config has none. */
async function ruleFiles(): Promise<string[]> {
  if (!existsSync(join(root, 'release/public.config.ts'))) return [];
  // A non-literal path: a checkout without release/ must not resolve this import statically (knip, tsc).
  const configPath = '../../release/public.config.ts';
  const { config } = (await import(configPath)) as { config: Parameters<typeof releaseRulePaths>[0] };
  return releaseRulePaths(config);
}

const exists = (file: string): boolean => existsSync(join(root, file));
const rules = await ruleFiles();
const changedPlan = selectChecks(files, exists, rules);
const rechecked = record !== undefined && !changedPlan.full ? recheckPlan(record, changedPlan, files, (some) => some.length > 0 && selectChecks(some, exists, rules).visual) : undefined;
const selected = rechecked?.plan ?? changedPlan;
// --quick never starts the full gate: a change that needs it runs every unit test, and the master's gate does the rest.
const plan = quick && selected.full ? { ...selected, full: false, testAll: true, reasons: [...selected.reasons, 'quick: the full gate is not run; every unit test runs instead'] } : selected;
const naming = filesNamingTickets(files, root);
const leakCheck = naming.length > 0;
plan.reasons.push(leakCheck ? `release-leaks: ${naming.length} changed file(s) name a ticket ID, so the release leak check runs` : 'release-leaks: skipped, no changed file names a ticket ID');
const chatty = !quick || dryRun;
if (chatty) console.log(`check:pr: ${files.length} file(s) changed against ${base}`);
if (chatty) for (const reason of plan.reasons) console.log(`  ${reason}`);
if (chatty && rechecked !== undefined && rechecked.reused.length > 0) console.log(`  recheck: reused from ${record!.sha.slice(0, 7)}, where they passed: ${rechecked.reused.join(', ')}`);

if (plan.full) {
  console.log('check:pr: running the full gate, pnpm check:local');
  if (dryRun) process.exit(0);
  const logDir = process.env.CHECK_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'agent-board-check-pr.'));
  mkdirSync(logDir, { recursive: true });
  const leaks = leakCheck ? (await run(leakCheckStep, logDir)).outcome : 'pass';
  if (leaks !== 'pass') {
    // As on the subset path, a failed quick check ends the run: the full gate could not pass it.
    console.log('check:pr: the release leak check failed; the full gate is not run');
    process.exit(1);
  }
  const full = spawn('sh', ['scripts/check-local.sh'], { cwd: root, stdio: 'inherit' });
  fullGate = full;
  full.on('close', (code) => process.exit(code ? 1 : 0));
} else {
  const steps = stepsFor(plan, { leakCheck, exists: (file) => existsSync(join(root, file)), headless: process.platform === 'linux' && !process.env.DISPLAY, quick });
  if (chatty) console.log(`check:pr: steps: ${steps.map((s) => s.name).join(', ')}`);
  if (dryRun) process.exit(0);
  const logDir = process.env.CHECK_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'agent-board-check-pr.'));
  mkdirSync(logDir, { recursive: true });
  const started = Date.now();
  const batteryAtStart = await readBatteryNote();
  if (!quick && batteryAtStart !== undefined) console.log(batteryAtStart);
  const results = new Map<string, { outcome: string; seconds: number }>();
  const settle = async (step: Step): Promise<void> => {
    const r = await run(step, logDir);
    results.set(r.name, r);
  };
  // Stages and early stops: runStages in steps.ts.
  const { notRun } = await runStages(steps, {
    settle,
    outcomeOf: (name) => results.get(name)?.outcome,
    runElectron: async (stages) => {
      // One Electron run at a time across the machine (scripts/e2e-lock): other gates queue, and this one reaps what its run left.
      const electronSteps = stages.flat();
      const lock = await acquireLock({ step: electronSteps.map((s) => s.name).join('+'), worktree: root }).catch((error: Error) => {
        console.error(error.message);
        return undefined;
      });
      if (lock === undefined) {
        for (const step of electronSteps) results.set(step.name, { outcome: 'FAIL', seconds: 0 });
        return;
      }
      heldLock = lock;
      try {
        await reapWorktree(root);
        for (const stage of stages) await Promise.all(stage.map(settle));
      } finally {
        await reapWorktree(root, process.pid);
        lock.release();
        heldLock = undefined;
      }
    },
  });
  if (!quick && notRun !== 'the build failed') console.log(`check:pr: ${notRun}; the rest is not run`);
  let failed = false;
  const rows: string[] = [];
  const flaky: string[] = [];
  for (const step of steps) {
    const r = results.get(step.name);
    if (!r) { rows.push(`| \`${step.name}\` | not run: ${notRun} | |`); failed = true; continue; }
    if (r.outcome !== 'pass') failed = true;
    const names = flakyOf(step, logDir);
    flaky.push(...names);
    rows.push(`| \`${step.name}\` | ${r.outcome}${names.length > 0 ? `, ${names.length} flaky` : ''} | ${r.seconds}s |`);
  }
  for (const name of rechecked?.reused ?? []) rows.push(`| \`${name}\` | reused: passed on ${record!.sha.slice(0, 7)} | |`);
  if (quick) {
    const read = (name: string): string => { try { return readFileSync(join(logDir, `${name}.log`), 'utf8'); } catch { return ''; } };
    const table = steps.map((step) => {
      const r = results.get(step.name) ?? { outcome: `not run: ${notRun}`, seconds: 0 };
      return { name: step.name, outcome: r.outcome, seconds: r.seconds, logPath: join(logDir, `${step.name}.log`), log: r.outcome === 'pass' ? undefined : read(step.name) };
    });
    console.log(quickReport(table, Math.round((Date.now() - started) / 1000)).join('\n'));
    process.exit(table.some((row) => row.outcome !== 'pass') ? 1 : 0);
  }
  const dirty = git('status', '--porcelain').length > 0;
  console.log(`\nPer-PR checks on \`${git('rev-parse', '--short', 'HEAD')}\`${dirty ? ' (with uncommitted changes)' : ''}, ${Math.round((Date.now() - started) / 1000)}s wall:\n`);
  console.log(['| Step | Result | Time |', '| --- | --- | --- |', ...rows].join('\n'));
  if (flaky.length > 0) console.log(`\nFlaky, passed on a retry (fix them; they don't fail the gate):\n\n${flaky.map((name) => `- ${name}`).join('\n')}`);
  if (record === undefined) console.log('\nThis is the subset for this change, not the full gate; the master runs `pnpm check:local` on main after merge.');
  else {
    // Never a green stamp: the release trusts one as a full pass, and a recheck is the subset check:pr chooses.
    console.log(`\nA recheck against the full run on ${record.sha.slice(0, 7)}, not the full gate: it writes no green stamp.`);
    if (!failed && rechecked?.failedRun === true && !dirty && git('rev-parse', 'HEAD') === startSha) {
      // The fix to a failed run passed: a record of its own lets a second fix recheck on top of this one.
      writeRecord(resultsDir(), composedRecord(record, startSha, git('rev-parse', 'HEAD^{tree}')));
      console.log(`Recheck passed on a clean tree: result record written for ${startSha.slice(0, 7)}, for a later recheck to build on.`);
    } else if (!failed && dirty) console.log('Recheck passed, but the tree has uncommitted changes: commit and run it again for a record a later recheck can build on.');
  }
  const slept = sleepNote(await readSleeps(new Date(started)), new Date(started), new Date());
  if (slept !== undefined) console.log(`\n${slept}`);
  // Read again: plugged in or unplugged since the start, the end is what the next run inherits.
  const batteryNow = await readBatteryNote();
  if (batteryNow !== undefined) console.log(`\n${batteryNow}`);
  writeFileSync(join(logDir, 'summary.md'), rows.join('\n'));
  process.exit(failed ? 1 : 0);
}

/** The record of a recheck that passed: every step of the full run's record passes on this tree, on top of that run. */
function composedRecord(from: GateRecord, sha: string, tree: string): GateRecord {
  return { ...from, sha, tree, at: new Date().toISOString(), rechecks: from.rechecks ?? from.sha, steps: Object.fromEntries(Object.keys(from.steps).map((name) => [name, { outcome: 'pass' }])) };
}
