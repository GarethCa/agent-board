import { describe, expect, it } from 'vitest';
import { batteryNote, lastSleepAt, parseSleeps, sleepNote } from './sleeps.ts';

// Lines as `pmset -g log` prints them: the time, the event padded to a column, a tab, then the details.
const LOG = [
  "2026-10-16 02:33:40 +0100 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using Batt (Charge:9%) 737 secs  ",
  '2026-10-16 02:45:57 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to rtc/Maintenance Using BATT (Charge:9%) 45 secs   ',
  "2026-10-16 02:46:42 +0100 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:8%) 42 secs   ",
  "2026-10-16 02:48:09 +0100 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:8%) 929 secs  ",
  '2026-10-16 02:48:11 +0100 PM Client Acks      \tDelays to Sleep notifications: [com.apple.bluetooth.sleep is slow(1534 ms)]',
  "2026-10-16 03:05:16 +0100 Sleep               \tEntering Sleep state due to 'Clamshell Sleep' Using AC (Charge:8%) 1080 secs ",
].join('\n');

const at = (text: string) => new Date(text);

describe('the sleeps in a power log', () => {
  it('reads each sleep, when it began and how long it lasted, and nothing else the log says', () => {
    expect(parseSleeps(LOG)).toEqual([
      { at: at('2026-10-16T02:33:40+01:00'), clock: '02:33', seconds: 737, reason: 'Idle Sleep' },
      { at: at('2026-10-16T02:46:42+01:00'), clock: '02:46', seconds: 42, reason: 'Sleep Service Back to Sleep' },
      { at: at('2026-10-16T02:48:09+01:00'), clock: '02:48', seconds: 929, reason: 'Maintenance Sleep' },
      { at: at('2026-10-16T03:05:16+01:00'), clock: '03:05', seconds: 1080, reason: 'Clamshell Sleep' },
    ]);
  });

  it('keeps a sleep with no length yet, the one the machine is still in, as lasting until now', () => {
    const open = "2026-10-16 03:05:16 +0100 Sleep               \tEntering Sleep state due to 'Idle Sleep' Using Batt (Charge:8%)";
    expect(parseSleeps(open)).toEqual([{ at: at('2026-10-16T03:05:16+01:00'), clock: '03:05', seconds: undefined, reason: 'Idle Sleep' }]);
  });
});

describe('the note a gate prints about sleep', () => {
  const sleeps = parseSleeps(LOG);

  it('says nothing when the machine never slept during the run', () => {
    expect(sleepNote(sleeps, at('2026-10-16T03:30:00+01:00'), at('2026-10-16T04:00:00+01:00'))).toBeUndefined();
  });

  it('names the sleeps that began during the run, their total, and that timings and timeouts include them', () => {
    const note = sleepNote(sleeps, at('2026-10-16T02:46:00+01:00'), at('2026-10-16T03:30:00+01:00'));
    expect(note).toBe(
      'The machine slept 3 times during this run, 2051 s in all (02:46 for 42 s, 02:48 for 929 s, 03:05 for 1080 s; ' +
        'Sleep Service Back to Sleep, Maintenance Sleep, Clamshell Sleep). Times in the table include it, and a test ' +
        'that spans a sleep can fail on its timeout without any fault of its own: plug the machine in and keep it awake, then run again.',
    );
  });

  it('counts the sleep the run began in, which it woke from', () => {
    const note = sleepNote(sleeps, at('2026-10-16T02:40:00+01:00'), at('2026-10-16T02:45:00+01:00'));
    expect(note).toMatch(/^The machine slept once during this run, 737 s in all \(02:33 for 737 s; Idle Sleep\)/);
  });

  it('counts a sleep the machine is still in as lasting until the run ended', () => {
    const open = parseSleeps("2026-10-16 03:05:16 +0100 Sleep               \tEntering Sleep state due to 'Idle Sleep' Using Batt (Charge:8%)");
    expect(sleepNote(open, at('2026-10-16T03:00:00+01:00'), at('2026-10-16T03:10:16+01:00'))).toMatch(/^The machine slept once during this run, 300 s in all/);
  });
});

describe('the warning a gate prints on battery', () => {
  it('names the charge when the machine runs on battery', () => {
    const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22610019)\t9%; discharging; 1:02 remaining present: true\n";
    expect(batteryNote(batt)).toBe('On battery at 9%: plug in, a closed lid or a low battery will still sleep the machine mid-run.');
  });

  it('says nothing on AC power, charging or not', () => {
    expect(batteryNote("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22610019)\t4%; charging; 2:35 remaining present: true\n")).toBeUndefined();
  });

  it('says nothing for a machine with no battery, or output it does not know', () => {
    expect(batteryNote("Now drawing from 'AC Power'\n")).toBeUndefined();
    expect(batteryNote('')).toBeUndefined();
  });

  it('still warns when the charge is missing', () => {
    expect(batteryNote("Now drawing from 'Battery Power'\n")).toBe('On battery: plug in, a closed lid or a low battery will still sleep the machine mid-run.');
  });
});

describe("the kernel's last sleep", () => {
  it('reads when the machine last went to sleep from `sysctl -n kern.sleeptime`', () => {
    expect(lastSleepAt('{ sec = 1792135698, usec = 563850 } Fri Oct 16 08:28:18 2026\n')).toEqual(new Date(1792135698_000));
  });

  it('knows nothing from a machine that never slept since boot, or output it does not know', () => {
    expect(lastSleepAt('{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970\n')).toBeUndefined();
    expect(lastSleepAt('')).toBeUndefined();
  });
});
