/**
 * `pnpm check:pr`: the per-PR gate. Looks at what the branch changed against origin/main, prints which checks it chose and
 * why, and runs just those, in parallel where they don't depend on each other. A change to the gate, the shared config,
 * the e2e helpers, the fake CLIs or the protocol runs the full `check:local` instead. Rules: select.ts.
 *
 *   node scripts/check-pr/main.ts [--dry-run] [--base <ref>]
 *
 * Run `git fetch origin` first so the diff is against the current main. --dry-run prints the plan and runs nothing. Exits non-zero if any step failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectChecks, type Plan } from './select.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baseIndex = args.indexOf('--base');
const baseArg = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
if (baseIndex >= 0 && !baseArg) {
  console.error('check:pr: --base needs a ref');
  process.exit(2);
}
const root = join(import.meta.dirname, '..', '..');

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

interface Step {
  name: string;
  argv: string[];
  /** Steps that start only once the build has passed. */
  needsBuild?: boolean;
}

function stepsFor(plan: Plan): Step[] {
  const linux = process.platform === 'linux' && !process.env.DISPLAY;
  const headless = linux ? ['sh', 'scripts/e2e-headless.sh'] : [];
  const steps: Step[] = [
    { name: 'lint', argv: ['pnpm', 'lint'] },
    { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
    { name: 'markdownlint', argv: ['pnpm', 'dlx', 'markdownlint-cli2@0.23.2'] },
  ];
  const related = plan.unit.filter((file) => existsSync(join(root, file)));
  if (related.length > 0) {
    steps.push({ name: 'unit', argv: ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', ...related] });
  }
  if (plan.e2e.length > 0 || plan.visual) steps.unshift({ name: 'build', argv: ['pnpm', 'build'] });
  if (plan.e2e.length > 0) {
    const specs = plan.e2e.map((spec) => `e2e/${spec}`);
    steps.push({
      name: 'e2e',
      needsBuild: true,
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'exec', 'playwright', 'test', '--project=app', ...specs],
    });
  }
  if (plan.visual) {
    steps.push({
      name: 'visual',
      needsBuild: true,
      // Its own output dir, beside the e2e one: Playwright empties its output dir at the start of a run.
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'test:visual', '--output', 'test-results-visual'],
    });
  }
  return steps;
}

function run(step: Step, logDir: string): Promise<{ name: string; outcome: string; seconds: number }> {
  const started = Date.now();
  const log = createWriteStream(join(logDir, `${step.name}.log`));
  return new Promise((resolve) => {
    const [cmd, ...rest] = step.argv;
    const child = spawn(cmd, rest, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => {
      log.end();
      const outcome = code === 0 ? 'pass' : 'FAIL';
      console.log(`${step.name}: ${outcome} (log: ${join(logDir, `${step.name}.log`)})`);
      resolve({ name: step.name, outcome, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const { files, base } = changedFiles();
const plan = selectChecks(files, (file) => existsSync(join(root, file)));
console.log(`check:pr: ${files.length} file(s) changed against ${base}`);
for (const reason of plan.reasons) console.log(`  ${reason}`);

if (plan.full) {
  console.log('check:pr: running the full gate, pnpm check:local');
  if (dryRun) process.exit(0);
  const full = spawn('sh', ['scripts/check-local.sh'], { cwd: root, stdio: 'inherit' });
  full.on('close', (code) => process.exit(code ?? 1));
} else {
  const steps = stepsFor(plan);
  console.log(`check:pr: steps: ${steps.map((s) => s.name).join(', ')}`);
  if (dryRun) process.exit(0);
  const logDir = process.env.CHECK_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'agent-board-check-pr.'));
  mkdirSync(logDir, { recursive: true });
  const started = Date.now();
  const results = new Map<string, { outcome: string; seconds: number }>();
  const settle = async (step: Step): Promise<void> => {
    const r = await run(step, logDir);
    results.set(r.name, r);
  };
  // Stages, as in check-local.sh; the heavy runs never overlap, because the unit tests (5-second timeouts) and the e2e fail
  // when starved. 1: lint, typecheck, markdownlint and the build. 2: unit. 3: the native visual run, then the e2e.
  const named = (...names: string[]): Step[] => steps.filter((s) => names.includes(s.name));
  await Promise.all(named('build', 'lint', 'typecheck', 'markdownlint').map(settle));
  await Promise.all(named('unit').map(settle));
  if (results.get('build')?.outcome !== 'FAIL') {
    for (const stage of [['visual'], ['e2e']]) await Promise.all(named(...stage).map(settle));
  }
  let failed = false;
  const rows: string[] = [];
  for (const step of steps) {
    const r = results.get(step.name);
    if (!r) { rows.push(`| \`${step.name}\` | not run: the build failed | |`); failed = true; continue; }
    if (r.outcome === 'FAIL') failed = true;
    rows.push(`| \`${step.name}\` | ${r.outcome} | ${r.seconds}s |`);
  }
  const dirty = git('status', '--porcelain').length > 0;
  console.log(`\nPer-PR checks on \`${git('rev-parse', '--short', 'HEAD')}\`${dirty ? ' (with uncommitted changes)' : ''}, ${Math.round((Date.now() - started) / 1000)}s wall:\n`);
  console.log(['| Step | Result | Time |', '| --- | --- | --- |', ...rows].join('\n'));
  console.log('\nThis is the subset for this change, not the full gate; the master runs `pnpm check:local` on main after merge.');
  writeFileSync(join(logDir, 'summary.md'), rows.join('\n'));
  process.exit(failed ? 1 : 0);
}
