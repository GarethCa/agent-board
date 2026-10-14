import { waitsForYou, type Agent, type PermissionPrompt } from '@agent-board/daemon/protocol';

/** Longest tool summary shown; the full input is in the agent's terminal. */
const MAX_SUMMARY_LENGTH = 300;

/**
 * The agents in the needs-you inbox, in board order: live ones waiting for input or needing permission, or with any
 * permission prompt pending, held for the inbox or asking in their terminal.
 */
export function needsYou(agents: readonly Agent[]): Agent[] {
  return agents.filter(waitsForYou);
}

/** The agent's prompts the inbox can still answer: the daemon holds their hooks. */
export function heldPrompts(agent: Agent): PermissionPrompt[] {
  return agent.permissions.filter((prompt) => prompt.heldUntil !== null);
}

/** Whole seconds, rounded up, until a held prompt's hold lapses to the terminal; 0 once it has. */
export function secondsLeft(prompt: PermissionPrompt, now: number): number {
  return prompt.heldUntil === null ? 0 : Math.max(0, Math.ceil((Date.parse(prompt.heldUntil) - now) / 1000));
}

/** What a permission prompt asks to do, in a line: a shell call's command, a file tool's path, or else its input. */
export function toolSummary(prompt: PermissionPrompt): string {
  const input = prompt.toolInput;
  let summary: string;
  if (input === null || input === undefined) summary = '';
  else if (typeof input === 'object' && 'command' in input && typeof input.command === 'string') summary = input.command;
  else if (typeof input === 'object' && 'file_path' in input && typeof input.file_path === 'string') summary = input.file_path;
  else summary = JSON.stringify(input);
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
