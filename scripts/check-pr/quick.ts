/**
 * The short report of `check:pr --quick`: one table row per step, and for a failing step only its failure lines.
 */

/** Lines of one failing step's log that say what failed: a failed test, an assertion, a file:line. */
const FAILURE_LINE = /\bFAIL\b|AssertionError|\bError\b|\berror\b|[×✗]|\S+\.(?:ts|tsx|js|mjs|css|md):\d+/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function failureLines(log: string, max = 40): string[] {
  const hits = log.replace(ANSI, '').split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0 && FAILURE_LINE.test(line));
  const unique = hits.filter((line, i) => hits.indexOf(line) === i);
  if (unique.length <= max) return unique;
  return [...unique.slice(0, max), `… ${unique.length - max} more line(s) in the full log`];
}

export interface QuickRow {
  name: string;
  outcome: string;
  seconds: number;
  /** The step's full log, read only when it failed. */
  log?: string;
  logPath: string;
}

/** The table, then each failed step's failures and the path to its full log. A green run is the header, the rows and a verdict. */
export function quickReport(rows: QuickRow[], wallSeconds: number): string[] {
  const out = [`check:pr --quick, ${wallSeconds}s:`, '| Step | Result | Time |', '| --- | --- | --- |'];
  for (const row of rows) out.push(`| ${row.name} | ${row.outcome === 'pass' ? 'pass' : row.outcome} | ${row.seconds}s |`);
  const failed = rows.filter((row) => row.outcome !== 'pass');
  for (const row of failed) {
    out.push('', `${row.name} failed (full log: ${row.logPath}):`);
    out.push(...failureLines(row.log ?? '').map((line) => `  ${line}`));
  }
  out.push('', failed.length === 0 ? 'quick checks passed (not the full gate: no e2e or visual run)' : `quick checks FAILED: ${failed.map((row) => row.name).join(', ')}`);
  return out;
}
