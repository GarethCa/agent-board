// Whose `FORCE_HYPERLINK` a Claude agent's environment holds: agent-board's own (the clickable links setting) or the
// user's. Kept free of imports, as both spawning and the settings report read it.

/**
 * Set beside the `FORCE_HYPERLINK=1` that agent-board gives a Claude agent, so an agent-board started from inside that
 * agent can tell its inherited `FORCE_HYPERLINK` from one the user set.
 */
export const FORCED_HYPERLINK_ENV = 'AGENT_BOARD_FORCED_HYPERLINK';

/**
 * Whether a `FORCE_HYPERLINK` the user set themselves in `env` makes Claude Code print links (as `supports-hyperlinks`
 * reads it: any value but a number 0), or null when they set none. One that carries our marker is not theirs.
 */
export function userForcedHyperlink(env: NodeJS.ProcessEnv): boolean | null {
  const value = env.FORCE_HYPERLINK;
  if (value === undefined || env[FORCED_HYPERLINK_ENV] !== undefined) return null;
  return !(value.length > 0 && Number.parseInt(value, 10) === 0);
}
