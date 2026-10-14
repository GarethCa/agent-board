import { nextRun, parseCron } from '@agent-board/daemon/cron';
import type { AgentSchedule } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many fire times the schedule editor previews. */
const PREVIEW_RUNS = 3;

/** A time near `now`, briefly, in local time: `09:05` today, `tomorrow 09:05`, `Fri 09:05` within a week, else the date. */
export function whenLabel(date: Date, now: Date): string {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (Math.abs(days) < 7) return `${WEEKDAYS[date.getDay()]} ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${time}`;
}

/**
 * What a scheduled agent's clock badge says, and its tooltip: when it next runs (relaunching it if its session has
 * `ended`), and how its last run went.
 */
export function clockBadge(schedule: AgentSchedule, ended: boolean, now: Date): { label: string; title: string } {
  const what = `(${schedule.cron}): ${schedule.prompt}`;
  let label: string;
  let title: string;
  if (!schedule.enabled || schedule.nextRunAt === null) {
    label = 'paused';
    title = `Paused ${what}`;
  } else {
    label = whenLabel(new Date(schedule.nextRunAt), now);
    title = `Next run ${label}${ended ? ' relaunches it' : ''} ${what}`;
  }
  const last = schedule.lastRun;
  if (last !== null) {
    const outcome = last.outcome === 'started' ? 'started' : `skipped${last.reason === null ? '' : `: ${last.reason}`}`;
    title += `\nLast run ${whenLabel(new Date(last.dueAt), now)} ${outcome}`;
  }
  return { label, title };
}

/** The next few fire times of a cron expression as it is typed, or why it can't be used. */
export function previewCron(expression: string, now: Date): { next: Date[] } | { error: string } {
  try {
    const cron = parseCron(expression);
    const next: Date[] = [];
    let after = now;
    for (let i = 0; i < PREVIEW_RUNS; i++) next.push((after = nextRun(cron, after)));
    return { next };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
