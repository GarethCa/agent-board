/**
 * Writes the gate's green stamps (stamp.ts), for check-local.sh once every step passed on a clean tree:
 *
 *   node scripts/gate-stamp/main.ts write <full-sha> <full-tree-hash>
 */
import { stampDir, writeStamp } from './stamp.ts';

const [command, sha, tree] = process.argv.slice(2);
if (command === 'write' && sha !== undefined && tree !== undefined) {
  const dir = stampDir();
  writeStamp(dir, sha, new Date(), tree);
  console.log(`Green stamp for ${sha.slice(0, 7)} (tree ${tree.slice(0, 7)}) written to ${dir}.`);
} else {
  console.error('usage: main.ts write <full-sha> <full-tree-hash>');
  process.exit(2);
}
