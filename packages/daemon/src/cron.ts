// Cron expressions for schedules: the standard five fields, in the daemon's local time. Pure and free of Node imports,
// so the app's schedule editor can check an expression and show its next run as it is typed.

/** A cron expression that can't be used, with a message that says why. */
export class CronError extends Error {
  override name = 'CronError';
}

/** A parsed cron expression. */
export interface Cron {
  /** As written, trimmed. */
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  /** 1–12. */
  readonly months: ReadonlySet<number>;
  /** 0–6, Sunday first. */
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the day-of-month and day-of-week fields were restricted (not starting with `*`). When both are, a day
   * matching either one fires, as in standard cron.
   */
  readonly daysOfMonthRestricted: boolean;
  readonly daysOfWeekRestricted: boolean;
  /** Whether the hour field was restricted. Only then does a wall-clock time that repeats when the clocks go back fire once. */
  readonly hoursRestricted: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface Field {
  name: string;
  min: number;
  max: number;
  /** Names accepted for values, lower case, the first standing for `min`. */
  names?: readonly string[];
}

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  // 7 is Sunday too.
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

/** The most days each month can have, February in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How many years ahead `nextRun` looks: past the next 29 February, whatever the year. */
const MAX_YEARS_AHEAD = 9;

const MINUTE_MS = 60_000;

/**
 * Parses a five-field cron expression (minute, hour, day of month, month, day of week) or one of the `@yearly`,
 * `@monthly`, `@weekly`, `@daily`, `@hourly` macros. Fields take `*`, numbers, `a-b` ranges, `/n` steps and
 * comma-separated lists; months and weekdays also take three-letter English names. Throws `CronError` for anything
 * else, or for an expression that can never fire (`0 0 30 2 *`).
 */
export function parseCron(expression: string): Cron {
  const trimmed = expression.trim();
  let source = trimmed;
  if (source.startsWith('@')) {
    const macro = MACROS[source.toLowerCase()];
    if (macro === undefined) throw new CronError(`${source} is not supported; use five fields or one of ${Object.keys(MACROS).join(', ')}`);
    source = macro;
  }
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError('a cron expression has five fields: minute, hour, day of month, month and day of week');
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parts.map((part, i) => parseField(part, FIELDS[i]!));
  const daysOfWeek = new Set([...rawDaysOfWeek!].map((day) => day % 7));
  const cron: Cron = {
    expression: trimmed,
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek,
    hoursRestricted: !parts[1]!.startsWith('*'),
    daysOfMonthRestricted: !parts[2]!.startsWith('*'),
    daysOfWeekRestricted: !parts[4]!.startsWith('*'),
  };
  // Only a day of month that alone picks the day can rule out every date.
  if (cron.daysOfMonthRestricted && !cron.daysOfWeekRestricted) {
    const possible = [...cron.months].some((month) => [...cron.daysOfMonth].some((day) => day <= MONTH_DAYS[month - 1]!));
    if (!possible) throw new CronError(`${trimmed} would never run: no month it names has that day`);
  }
  return cron;
}

function parseField(text: string, field: Field): Set<number> {
  const values = new Set<number>();
  const fail = (why: string): never => {
    throw new CronError(`bad ${field.name} field "${text}": ${why}`);
  };
  for (const item of text.split(',')) {
    if (item === '') fail('empty list item');
    const [range, stepText, ...extra] = item.split('/');
    if (extra.length > 0) fail('more than one step');
    const step = stepText === undefined ? 1 : number(stepText, fail);
    if (step < 1) fail('a step must be at least 1');
    let start: number;
    let end: number;
    if (range === '*') {
      start = field.min;
      // `*` covers each weekday once.
      end = field.name === 'day of week' ? 6 : field.max;
    } else {
      const [from, to, ...more] = range!.split('-');
      if (more.length > 0) fail('a range has one start and one end');
      start = value(from!, field, fail);
      // `a/n` runs from a to the end of the field.
      end = to !== undefined ? value(to, field, fail) : stepText !== undefined ? field.max : start;
      if (start > end) fail(`the range runs backwards`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

function value(text: string, field: Field, fail: (why: string) => never): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  const v = named >= 0 ? field.min + named : number(text, fail);
  if (v < field.min || v > field.max) fail(`${v} is outside ${field.min}–${field.max}`);
  return v;
}

function number(text: string, fail: (why: string) => never): number {
  if (!/^\d+$/.test(text)) fail(`"${text}" is not a number${/[LW#?]/i.test(text) ? ' (L, W, # and ? are not supported)' : ''}`);
  return Number(text);
}

/**
 * The first whole minute strictly after `after` at which `cron` fires, in local time. When the clocks go forward over
 * a time it would fire, it fires at the first minute after the jump instead. When they go back, a wall-clock time
 * that repeats fires only the first time, unless the hour field is `*` (then both passes are distinct runs).
 */
export function nextRun(cron: Cron, after: Date): Date {
  let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const lastYear = after.getFullYear() + MAX_YEARS_AHEAD;
  for (;;) {
    const date = new Date(t);
    if (date.getFullYear() > lastYear) throw new CronError(`${cron.expression} has no run in the next ${MAX_YEARS_AHEAD} years`);
    if (firesInSkippedTime(cron, t)) return date;
    if (!cron.months.has(date.getMonth() + 1)) {
      t = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
    } else if (!dayMatches(cron, date.getDate(), date.getDay())) {
      t = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    } else if (!cron.hours.has(date.getHours())) {
      t += (60 - date.getMinutes()) * MINUTE_MS;
    } else if (!cron.minutes.has(date.getMinutes()) || (cron.hoursRestricted && isRepeatedWallTime(t))) {
      t += MINUTE_MS;
    } else {
      return date;
    }
  }
}

function dayMatches(cron: Cron, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonth = cron.daysOfMonth.has(dayOfMonth);
  const byWeek = cron.daysOfWeek.has(dayOfWeek);
  if (cron.daysOfMonthRestricted && cron.daysOfWeekRestricted) return byMonth || byWeek;
  return byMonth && byWeek;
}

/** A local wall-clock time as a number, so wall times can be compared and stepped through. */
function wallTime(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
}

/** Whether the clocks jumped forward just before `t`, over a wall-clock time at which `cron` fires. */
function firesInSkippedTime(cron: Cron, t: number): boolean {
  const now = wallTime(new Date(t));
  for (let wall = wallTime(new Date(t - MINUTE_MS)) + MINUTE_MS; wall < now; wall += MINUTE_MS) {
    const skipped = new Date(wall);
    if (
      cron.months.has(skipped.getUTCMonth() + 1) &&
      dayMatches(cron, skipped.getUTCDate(), skipped.getUTCDay()) &&
      cron.hours.has(skipped.getUTCHours()) &&
      cron.minutes.has(skipped.getUTCMinutes())
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the wall-clock time at `t` already happened earlier, before the clocks went back. */
function isRepeatedWallTime(t: number): boolean {
  const date = new Date(t);
  const shift = date.getTimezoneOffset() - new Date(t - 3 * 60 * MINUTE_MS).getTimezoneOffset();
  return shift > 0 && wallTime(new Date(t - shift * MINUTE_MS)) === wallTime(date);
}
