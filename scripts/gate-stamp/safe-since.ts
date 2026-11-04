/**
 * Whether a commit may borrow the green stamp of an ancestor. The full gate is about 35 minutes; a one-line fix on top
 * of a stamped commit would otherwise start it again. The follow-up counts as safe when everything it changed is
 * covered by the quick verify (`check:local --quick`), it touches nothing the visual and e2e runs or the daemon suite
 * watch, and it is small (or only tests and docs).
 */
import { execFileSync } from 'node:child_process';
import { readStamp } from './stamp.ts';

/** A follow-up of more changed lines than this, in files that are not tests or docs, runs the full gate. */
export const SAFE_MAX_CHANGED_LINES = 20;

/** How many commits back from the release to look for a stamp. */
const MAX_STAMP_DISTANCE = 50;

export interface FileChange {
  path: string;
  /** Added plus deleted lines; undefined for a binary file. */
  lines: number | undefined;
}

export interface SafeVerdict {
  safe: boolean;
  /** Why, for the release log. */
  reason: string;
}

const isDoc = (path: string): boolean => /\.md$/.test(path) || path.startsWith('docs/');
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
/**
 * Renderer modules whose values reach the screen (palettes, styles, sizes, shapes, layout, looks): the visual run checks
 * them. A name heuristic, matched against the whole path under the renderer so a folder like `shapes/` counts too; it
 * errs towards the full gate, and a renderer module that renders under another name needs a word added here.
 */
const RENDERS = /(theme|colou?r|style|layout|geometry|design|states|font|motion|token|palette|look|size|shape|width)/i;
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * What the quick verify (lint, typecheck, markdownlint, knip, build, the selected unit tests) fully covers, as an
 * allow-list: a path that matches nothing here is checked only by the e2e, visual or daemon runs, or by nothing the
 * quick verify can see, and so is unsafe. A reason for refusing it is returned for the log.
 *
 * Renderer `.ts` modules are allowed (a knip fix to an `export` there is the case this exists for) within the line cap;
 * `.tsx` components, stylesheets and everything else under the app stay unsafe, as do Electron main and preload,
 * `src/shared`, the fake harness, fixtures, Playwright and builder config, gate shell scripts and every `package.json`.
 */
function coveredByQuickVerify(path: string): boolean {
  // Before the doc check: a Markdown file under release/ is the public README, which the release rules test reads.
  if (path.startsWith('apps/desktop/e2e/') || path.startsWith('packages/daemon/') || path.startsWith('release/')) return false;
  if (isDoc(path)) return true;
  if (isTest(path)) return true;
  if (path.startsWith('scripts/')) return !path.endsWith('.sh') && !/^scripts\/(e2e|visual)[^/]*\//.test(path);
  if (path.startsWith('apps/desktop/src/renderer/')) return /\.ts$/.test(path) && !RENDERS.test(path.slice('apps/desktop/src/renderer/'.length));
  if (!path.includes('/')) return path === 'knip.json' || path === 'eslint.config.js' || /^tsconfig[\w.-]*\.json$/.test(path) || /^vitest[\w.-]*\.ts$/.test(path);
  return /^vitest[\w.-]*\.ts$/.test(base(path)) && path.startsWith('apps/desktop/');
}

export function safeSinceStamp(changes: readonly FileChange[]): SafeVerdict {
  if (changes.length === 0) return { safe: true, reason: 'no files changed' };
  for (const { path } of changes) {
    if (!coveredByQuickVerify(path)) return { safe: false, reason: `${path} is not covered by the quick checks alone (an e2e, visual, daemon or packaging run covers it)` };
  }
  // Tests and docs may be any size: only the code they accompany counts towards the cap.
  const code = changes.filter(({ path }) => !isTest(path) && !isDoc(path));
  if (code.some(({ lines }) => lines === undefined)) return { safe: false, reason: 'a binary file changed' };
  if (code.length === 0) return { safe: true, reason: `${changes.length} file(s), only tests and docs` };
  const lines = code.reduce((sum, { lines: n }) => sum + (n ?? 0), 0);
  if (lines > SAFE_MAX_CHANGED_LINES) {
    return { safe: false, reason: `${lines} changed lines outside tests and docs, more than ${SAFE_MAX_CHANGED_LINES}` };
  }
  return { safe: true, reason: `${lines} changed line(s) outside tests and docs, in ${changes.length} file(s) all covered by the quick checks` };
}

/** Parses `git diff --numstat -z` output. A rename arrives as `n\tn\t\0old\0new\0`; only the new path counts. */
export function parseNumstat(output: string): FileChange[] {
  const parts = output.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i] ?? '');
    if (match === null) continue;
    const [, added, deleted, path] = match as unknown as [string, string, string, string];
    const lines = added === '-' || deleted === '-' ? undefined : Number(added) + Number(deleted);
    if (path === '') {
      // A rename or copy: the next two entries are the old and new paths. Count the old path as changed too.
      changes.push({ path: parts[i + 1] ?? '', lines }, { path: parts[i + 2] ?? '', lines });
      i += 2;
    } else {
      changes.push({ path, lines });
    }
  }
  return changes;
}

export interface Reuse {
  /** The nearest stamped ancestor and when it passed. */
  ancestor: string;
  stampedAt: Date;
  /** How many commits `ancestor` is behind `sha`. */
  behind: number;
  verdict: SafeVerdict;
}

/**
 * The nearest ancestor of `sha` (not `sha` itself) whose stamp is `fresh`, with the verdict on the commits since.
 * Undefined when none is within MAX_STAMP_DISTANCE commits. Stamps that are not fresh are walked past: an older
 * ancestor with a fresh stamp still counts.
 */
export function findReusableStamp(repo: string, sha: string, stampDir: string, fresh: (stampedAt: Date) => boolean = () => true): Reuse | undefined {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  let history: string[];
  try {
    history = git('rev-list', `--max-count=${MAX_STAMP_DISTANCE + 1}`, sha).split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
  for (const [behind, ancestor] of history.entries()) {
    if (behind === 0) continue;
    const stampedAt = readStamp(stampDir, ancestor);
    if (stampedAt === undefined || !fresh(stampedAt)) continue;
    // A merge commit's diff against the stamp covers everything it brought in, so the range diff is the honest measure.
    let verdict: SafeVerdict;
    try {
      // numstat counts a submodule move as one line, however much it pulls in: refuse any gitlink (mode 160000).
      const raw = git('diff', '--raw', '--no-abbrev', `${ancestor}..${sha}`);
      verdict = /^:(160000 |\d+ 160000 )/m.test(raw)
        ? { safe: false, reason: 'a submodule changed' }
        : safeSinceStamp(parseNumstat(git('diff', '--numstat', '-z', '-M', `${ancestor}..${sha}`)));
    } catch {
      verdict = { safe: false, reason: `git could not diff ${ancestor.slice(0, 7)}..${sha.slice(0, 7)}` };
    }
    return { ancestor, stampedAt, behind, verdict };
  }
  return undefined;
}
