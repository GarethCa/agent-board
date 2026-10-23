import type { Agent } from '@agent-board/daemon/protocol';

/** How long a command has run, as its tile says it: `40 s`, `22 min`, `1 h 05`. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * What an agent `on-command` shows of its commands: the longest-running one and how long it has run, and how many more
 * run beside it. Undefined while it runs none.
 */
export function commandLine(agent: Pick<Agent, 'state' | 'commands'>, now: number): { command: string; more: number; elapsed: string } | undefined {
  const [longest, ...rest] = agent.state === 'on-command' ? agent.commands : [];
  if (longest === undefined) return undefined;
  return { command: longest.command, more: rest.length, elapsed: elapsedLabel(now - Date.parse(longest.startedAt)) };
}
