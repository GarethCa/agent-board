// A line of the daemon's log (`daemon.log`): when it was written, in local time with its offset, then the message.

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0');

/** `at` in local time with its UTC offset, to the millisecond: `2026-11-01T16:00:03.120+00:00`. */
function localStamp(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
  return `${date}T${time}${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** A daemon log line: its time, then `[agent-board daemon]` and the message. */
export function logLine(message: string, at = new Date()): string {
  return `${localStamp(at)} [agent-board daemon] ${message}`;
}
