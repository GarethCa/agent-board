/**
 * What a board hands every session it starts (`sessionEnv` in packages/daemon, ADR-0010): where its hook ingress and
 * socket are, and who the session is. A test run started from inside an agent on a live board inherits them, and
 * then the fakes' hooks, the hook forwarder and the `agent-board` CLI talk to the live board, not the test's own
 * daemon. Kept in step with the daemon's names by packages/daemon/test/board-guard.test.ts.
 */
export const BOARD_SESSION_VARS = [
  'AGENT_BOARD_HOOK_URL',
  'AGENT_BOARD_HOOK_TOKEN',
  'AGENT_BOARD_SOCKET',
  'AGENT_BOARD_IDENTITY',
  'AGENT_BOARD_ZONE_ID',
  'AGENT_BOARD_SESSION_ID',
] as const;

/**
 * The `AGENT_BOARD_*` variables that steer a run rather than the app under test, which a run keeps: the merge gate's
 * marks (ADR-0013), the e2e worker count and lock, headed e2e windows and onboarding screenshots. scripts/check-local.sh
 * keeps the same list.
 */
export const RUN_KNOBS = [
  'AGENT_BOARD_GATE',
  'AGENT_BOARD_E2E_WORKERS',
  'AGENT_BOARD_E2E_LOCK',
  'AGENT_BOARD_E2E_LOCK_WAIT_MIN',
  'AGENT_BOARD_HEADED',
  'AGENT_BOARD_E2E_SHOTS',
] as const;

/** Removes the session variables of an enclosing board from `env` (the process's own by default). */
export function scrubBoardSessionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const name of BOARD_SESSION_VARS) delete env[name];
  return env;
}

/**
 * Removes every `AGENT_BOARD_*` variable but the run knobs from `env` (the process's own by default), for the start of
 * a test run: whatever the app reads then comes only from what the run's own setup and tests set.
 */
export function scrubBoardEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) {
    if (name.startsWith('AGENT_BOARD_') && !(RUN_KNOBS as readonly string[]).includes(name)) delete env[name];
  }
  return env;
}
