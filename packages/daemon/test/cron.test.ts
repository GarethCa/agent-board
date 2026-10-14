import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from '../src/cron.ts';
import { pinTimeZone } from './pin-time-zone.ts';

// Local time, in a zone with daylight saving, so the DST cases mean something.
pinTimeZone('Europe/London');

/** Local time: `at(2026, 10, 10, 7, 30)` is 10 Oct 2026 07:30 (months from 1, as people write them). */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

/** The next `count` fire times after `from`. */
function runs(expression: string, from: Date, count = 3): Date[] {
  const cron = parseCron(expression);
  const times: Date[] = [];
  let after = from;
  for (let i = 0; i < count; i++) times.push((after = nextRun(cron, after)));
  return times;
}

describe('parseCron', () => {
  it('keeps the expression as written, trimmed', () => {
    expect(parseCron('  */5 * * * *  ').expression).toBe('*/5 * * * *');
  });

  it.each([
    ['', 'five fields'],
    ['* * * *', 'five fields'],
    ['* * * * * *', 'five fields'],
    ['60 * * * *', 'minute'],
    ['* 24 * * *', 'hour'],
    ['* * 0 * *', 'day of month'],
    ['* * 32 * *', 'day of month'],
    ['* * * 13 * ', 'month'],
    ['* * * * 8', 'day of week'],
    ['5-1 * * * *', 'minute'],
    ['*/0 * * * *', 'minute'],
    ['a * * * *', 'minute'],
    ['1,,2 * * * *', 'minute'],
    ['* * L * *', 'day of month'],
    ['* * * * 1#2', 'day of week'],
    ['* * ? * *', 'day of month'],
    ['@reboot', '@reboot'],
    ['0 0 30 2 *', 'never'],
    ['0 0 31 4,6,9,11 *', 'never'],
  ])('rejects %j, naming the problem (%s)', (expression, problem) => {
    expect(() => parseCron(expression)).toThrow(CronError);
    expect(() => parseCron(expression)).toThrow(problem);
  });

  it('accepts what standard cron accepts', () => {
    for (const expression of [
      '* * * * *',
      '0 9 * * 1-5',
      '*/15 8-18 * * mon-fri',
      '0 0 1 jan,JUL *',
      '30 2 29 2 *',
      '0 12 * * 7',
      '5,10-20/5,59 * * * *',
      '0 3/6 * * *',
      '@hourly',
      '@daily',
      '@midnight',
      '@weekly',
      '@monthly',
      '@yearly',
      '@annually',
    ]) {
      expect(() => parseCron(expression), expression).not.toThrow();
    }
  });
});

describe('nextRun', () => {
  const from = at(2026, 10, 10, 7, 30, 15); // a Saturday

  it('is the next whole minute that matches, strictly after the time given', () => {
    expect(runs('* * * * *', from)).toEqual([at(2026, 10, 10, 7, 31), at(2026, 10, 10, 7, 32), at(2026, 10, 10, 7, 33)]);
    expect(nextRun(parseCron('31 7 * * *'), at(2026, 10, 10, 7, 31))).toEqual(at(2026, 10, 11, 7, 31));
  });

  it('steps, ranges and lists', () => {
    expect(runs('*/20 * * * *', from)).toEqual([at(2026, 10, 10, 7, 40), at(2026, 10, 10, 8, 0), at(2026, 10, 10, 8, 20)]);
    expect(runs('5,10-20/5,59 * * * *', from, 5)).toEqual([
      at(2026, 10, 10, 7, 59),
      at(2026, 10, 10, 8, 5),
      at(2026, 10, 10, 8, 10),
      at(2026, 10, 10, 8, 15),
      at(2026, 10, 10, 8, 20),
    ]);
    expect(runs('0 3/6 * * *', from)).toEqual([at(2026, 10, 10, 9, 0), at(2026, 10, 10, 15, 0), at(2026, 10, 10, 21, 0)]);
  });

  it('weekdays, by number or name, with 0 and 7 both Sunday', () => {
    expect(runs('0 9 * * 1-5', from)).toEqual([at(2026, 10, 12, 9), at(2026, 10, 13, 9), at(2026, 10, 14, 9)]);
    expect(runs('0 9 * * MON-fri', from)).toEqual(runs('0 9 * * 1-5', from));
    expect(runs('0 12 * * 7', from, 2)).toEqual([at(2026, 10, 11, 12), at(2026, 10, 18, 12)]);
    expect(runs('0 12 * * 0', from, 2)).toEqual(runs('0 12 * * 7', from, 2));
    expect(runs('0 12 * * 5-7', from, 3)).toEqual([at(2026, 10, 10, 12), at(2026, 10, 11, 12), at(2026, 10, 16, 12)]);
  });

  it('months by number or name, crossing into the next year', () => {
    expect(runs('0 0 1 jan,jul *', from)).toEqual([at(2027, 1, 1), at(2027, 7, 1), at(2028, 1, 1)]);
  });

  it('skips months too short for the day, and finds 29 February in the next leap year', () => {
    expect(runs('0 6 31 * *', from)).toEqual([at(2026, 10, 31, 6), at(2026, 12, 31, 6), at(2027, 1, 31, 6)]);
    expect(runs('30 2 29 2 *', from, 2)).toEqual([at(2028, 2, 29, 2, 30), at(2032, 2, 29, 2, 30)]);
  });

  it('fires on either the day of month or the day of week when both are restricted, as cron does', () => {
    // The 13th, or any Friday.
    expect(runs('0 0 13 * 5', from)).toEqual([at(2026, 10, 13), at(2026, 10, 16), at(2026, 10, 23)]);
    // A starred day of month leaves only the weekday.
    expect(runs('0 0 */1 * 5', from, 2)).toEqual([at(2026, 10, 16), at(2026, 10, 23)]);
  });

  it('macros', () => {
    expect(nextRun(parseCron('@hourly'), from)).toEqual(at(2026, 10, 10, 8));
    expect(nextRun(parseCron('@daily'), from)).toEqual(at(2026, 10, 11));
    expect(nextRun(parseCron('@weekly'), from)).toEqual(at(2026, 10, 11));
    expect(nextRun(parseCron('@monthly'), from)).toEqual(at(2026, 11, 1));
    expect(nextRun(parseCron('@yearly'), from)).toEqual(at(2027, 1, 1));
  });

  it('fires once at the next time that exists when the clocks go forward over it', () => {
    // 29 March 2026: 01:00 GMT jumps to 02:00 BST, so 01:30 never happens that day.
    expect(runs('30 1 * * *', at(2026, 3, 28, 12), 3)).toEqual([at(2026, 3, 29, 2), at(2026, 3, 30, 1, 30), at(2026, 3, 31, 1, 30)]);
    expect(runs('0 9 * * *', at(2026, 3, 28, 12), 2)).toEqual([at(2026, 3, 29, 9), at(2026, 3, 30, 9)]);
  });

  it('fires once when the clocks go back over it', () => {
    // 25 October 2026: 02:00 BST falls back to 01:00 GMT, so 01:30 happens twice.
    const [first, second] = runs('30 1 * * *', at(2026, 10, 25, 0), 2);
    expect(first!.getTime()).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(second).toEqual(at(2026, 10, 26, 1, 30));
    // A schedule with no fixed hour fires through both passes of the hour, as cron does.
    const minutes = runs('* * * * *', at(2026, 10, 25, 0, 58), 125);
    expect(minutes.at(-1)!.getTime() - minutes[0]!.getTime()).toBe(124 * 60_000);
    expect(runs('30 * * * *', at(2026, 10, 25, 0, 45), 3).map((date) => date.getTime())).toEqual([
      Date.UTC(2026, 9, 25, 0, 30),
      Date.UTC(2026, 9, 25, 1, 30),
      Date.UTC(2026, 9, 25, 2, 30),
    ]);
  });
});
