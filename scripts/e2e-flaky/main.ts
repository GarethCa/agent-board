/**
 * Prints the flaky tests (flaky.ts) of the Playwright JSON reports given, one per line, for check-local.sh. A report
 * that is missing or unreadable (the run never started) adds nothing.
 *
 *   node scripts/e2e-flaky/main.ts <report.json>...
 */
import { readFileSync } from 'node:fs';
import { flakyTests } from './flaky.ts';

function read(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

for (const path of process.argv.slice(2)) for (const name of flakyTests(read(path))) console.log(name);
