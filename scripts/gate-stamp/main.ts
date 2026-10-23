/**
 * Writes the gate's green stamp (stamp.ts), for check-local.sh once every step passed on a clean tree:
 *
 *   node scripts/gate-stamp/main.ts write <full-sha>
 */
import { stampDir, writeStamp } from './stamp.ts';

const [command, sha] = process.argv.slice(2);
if (command === 'write' && sha !== undefined) {
  const dir = stampDir();
  writeStamp(dir, sha, new Date());
  console.log(`Green stamp for ${sha.slice(0, 7)} written to ${dir}.`);
} else {
  console.error('usage: main.ts write <full-sha>');
  process.exit(2);
}
