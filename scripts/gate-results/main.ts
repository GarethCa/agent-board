/**
 * Writes the result record of a check-local.sh run (results.ts), for `check:pr --recheck` to build on:
 *
 *   node scripts/gate-results/main.ts write <full-sha> <log-dir> <step>…
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { recordFromLogs, resultsDir, writeRecord } from './results.ts';

const root = join(import.meta.dirname, '..', '..');
const [command, sha, logDir, ...steps] = process.argv.slice(2);
if (command !== 'write' || sha === undefined || logDir === undefined || steps.length === 0) {
  console.error('usage: main.ts write <full-sha> <log-dir> <step>…');
  process.exit(2);
}
const dir = resultsDir();
let record: ReturnType<typeof recordFromLogs>;
try {
  const tree = execFileSync('git', ['-C', root, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim();
  record = recordFromLogs({ logDir, steps, sha, tree, root, at: new Date() });
  writeRecord(dir, record);
} catch (error) {
  // The gate's own result stands; only a later recheck loses its record.
  console.error(`No result record written: ${(error as Error).message.split('\n')[0]}`);
  process.exit(0);
}
const failed = Object.entries(record.steps).filter(([, step]) => step.outcome !== 'pass');
console.log(`Result record for ${sha.slice(0, 7)} written to ${dir}${failed.length === 0 ? '' : `: ${failed.length} step(s) to recheck after a fix (pnpm check:pr --recheck)`}.`);
