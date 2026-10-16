/**
 * The gate's guard against machine sleep, for check-local.sh (see sleeps.ts):
 *
 *   node scripts/machine-sleep/main.ts keep-awake <pid>     holds a sleep assertion until <pid> exits
 *   node scripts/machine-sleep/main.ts note <started-epoch>  prints a note if the machine slept since then
 *   node scripts/machine-sleep/main.ts battery               prints a warning if the machine runs on battery
 */
import { keepAwake, readBatteryNote, readSleeps, sleepNote } from './sleeps.ts';

const [command, value] = process.argv.slice(2);
if (command === 'keep-awake' && value !== undefined) {
  keepAwake(Number(value));
} else if (command === 'note' && value !== undefined) {
  const started = new Date(Number(value) * 1000);
  const note = sleepNote(await readSleeps(started), started, new Date());
  if (note !== undefined) console.log(`\n${note}`);
} else if (command === 'battery') {
  const note = await readBatteryNote();
  if (note !== undefined) console.log(note);
} else {
  console.error('usage: main.ts keep-awake <pid> | note <started-epoch-seconds> | battery');
  process.exit(2);
}
