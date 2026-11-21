import { delimiter } from 'node:path';

/**
 * The environment variables that point the daemon at fakes, or speed it up, for tests. A packaged app's daemon ignores
 * them unless `$AGENT_BOARD_TEST=1` (which the app's e2e launches set), so nothing in its environment can send the
 * stored Linear key somewhere else, run another `gh` or agent binary, move the hook shim every agent runs, or make it
 * poll in a tight loop.
 *
 * What stays live in every build is user configuration, not a test hook: `$AGENT_BOARD_WORKTREES_DIR`,
 * `$AGENT_BOARD_REPOS_DIR` and `$AGENT_BOARD_SCRATCH_DIR`, where the daemon puts the user's own folders.
 */
interface TestOverrides {
  /** `$AGENT_BOARD_LINEAR_API_URL`: where the Linear tracker sends its queries. */
  linearApiUrl?: string;
  /** `$AGENT_BOARD_GH`: the GitHub CLI to run. */
  gh?: string;
  /** `$AGENT_BOARD_KEYCHAIN`: the macOS keychain file tracker credentials live in. */
  keychain?: string;
  /** `$AGENT_BOARD_LINK_FETCH_HTML`: the HTML file every link card's page is read from. */
  linkFetchHtml?: string;
  /** `$AGENT_BOARD_HARNESS_DIRS`: the folders `claude` and `codex` are looked for in first. */
  harnessDirs?: string[];
  /** `$AGENT_BOARD_HOOK_SHIM`: where the launcher agents' hooks run is written. */
  hookShim?: string;
  /** `$AGENT_BOARD_EXTERNAL_HOOK_FILE`: where the daemon leaves its address for external sessions' hooks. */
  externalHookFile?: string;
  /** `$AGENT_BOARD_LOGIN_SHELL=0`: shells start without `-l`, so they don't read the developer's profile. */
  noLoginShell?: boolean;
  /** `$AGENT_BOARD_PULL_REQUEST_POLL_MS`: how often agents' pull requests are asked for. */
  pullRequestPollMs?: number;
  /** `$AGENT_BOARD_FLOW_RECHECK_MS`: how often held flow payloads are checked again. */
  flowRecheckMs?: number;
  /** `$AGENT_BOARD_START_LIMIT_MS`: how long an agent may take to start. */
  startLimitMs?: number;
  /** `$AGENT_BOARD_SUBMIT_CONFIRM_MS`: how long a submitted prompt waits to be confirmed. */
  submitConfirmMs?: number;
  /** `$AGENT_BOARD_RESUME_AFTER_RESTART=0`: the start leaves what a restart stopped stopped, for the restart banner's tests. */
  noResumeAfterRestart?: boolean;
}

/** The overrides `env` sets, or none when `honour` is false. An empty value, or a number that isn't one, is no override. */
export function readTestOverrides(honour: boolean, env: NodeJS.ProcessEnv = process.env): TestOverrides {
  if (!honour) return {};
  const value = (name: string) => env[name] || undefined;
  const ms = (name: string) => Number(env[name]) || undefined;
  return {
    linearApiUrl: value('AGENT_BOARD_LINEAR_API_URL'),
    gh: value('AGENT_BOARD_GH'),
    keychain: value('AGENT_BOARD_KEYCHAIN'),
    linkFetchHtml: value('AGENT_BOARD_LINK_FETCH_HTML'),
    harnessDirs: env.AGENT_BOARD_HARNESS_DIRS?.split(delimiter).filter(Boolean),
    hookShim: value('AGENT_BOARD_HOOK_SHIM'),
    externalHookFile: value('AGENT_BOARD_EXTERNAL_HOOK_FILE'),
    noLoginShell: env.AGENT_BOARD_LOGIN_SHELL === '0' || undefined,
    pullRequestPollMs: ms('AGENT_BOARD_PULL_REQUEST_POLL_MS'),
    flowRecheckMs: ms('AGENT_BOARD_FLOW_RECHECK_MS'),
    startLimitMs: ms('AGENT_BOARD_START_LIMIT_MS'),
    submitConfirmMs: ms('AGENT_BOARD_SUBMIT_CONFIRM_MS'),
    noResumeAfterRestart: env.AGENT_BOARD_RESUME_AFTER_RESTART === '0' || undefined,
  };
}
