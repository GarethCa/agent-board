// What a queue's or to-do list's rows say of who and when, and its head of who may use it: kept apart from React, so it is tested on its own.
import type { StepsWho } from '@agent-board/daemon/protocol';

const DAY = 24 * 60 * 60 * 1000;

/** Who may use it, as its head's chip says: its zone's agents, every agent on the board, or only the user. */
export function scopeText(noAgents: boolean, zoneName: string | undefined): string {
  if (noAgents) return 'No agents';
  return zoneName === undefined ? 'Board' : `Zone · ${zoneName}`;
}

/** Who wrote a row last, as its corner says: "you", or the agent's name. */
export function whoText(who: StepsWho): string {
  return who.kind === 'user' ? 'you' : who.name;
}

/** When, as a row's corner says: the time today, the weekday this week, else the day and month. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - at.getTime() < 6 * DAY) return at.toLocaleDateString('en-GB', { weekday: 'short' });
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
