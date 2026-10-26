import { delimiter } from 'node:path';
import { fakeBinDir } from './paths.ts';
import { scrubBoardSessionEnv } from './board-guard.ts';
import type { FakeScenario } from './scenarios.ts';

export { fakeBinDir } from './paths.ts';
export { SCENARIOS, type FakeScenario } from './scenarios.ts';
export { installHarnessGuard, harnessGuardGlobalSetup, guardChildProcess, realHarnessFor, type HarnessGuard } from './guard.ts';
export { BOARD_SESSION_VARS, RUN_KNOBS, scrubBoardSessionEnv, scrubBoardEnv } from './board-guard.ts';
export { REPO_GIT_VARS, leakedGitVars, scrubGitEnv, gitGuardGlobalSetup, assertCoreConfigUnchanged, coreConfigOf } from './git-guard.ts';
export { HARNESS_NAMES, type HarnessName } from './paths.ts';
export {
  RATE_LIMIT_CONTINUE,
  RATE_LIMIT_CREDITS_ROW,
  RATE_LIMIT_MENU_TITLE,
  RATE_LIMIT_STOP_ROW,
  RATE_LIMIT_UPGRADE_ROW,
  drawRateLimitMenu,
  rateLimitMenuRows,
} from './rate-limit-menu.ts';

export interface FakeHarnessEnvOptions {
  scenario: FakeScenario;
  /** Home directory the fakes treat as `~` (where `~/.claude` and `~/.codex` live). Use a temp dir. */
  home: string;
  /** Pause between streamed words and tool steps. Defaults to 0. */
  stepDelayMs?: number;
  /** With more than 0, streamed text comes a character at a time, this many ms apart, instead of a word a step. Defaults to 0. */
  typeMs?: number;
  /** How long an idle Claude session waits before firing `idle_prompt`. Defaults to 0; the real CLI waits about 60 s. */
  idleNotifyMs?: number;
  /** Replay the scenario for every later prompt too, instead of a plain turn. Defaults to false. */
  repeat?: boolean;
  /**
   * Whether an interrupted turn cancels the MCP call it was in (`notifications/cancelled`), as the real CLIs are
   * expected to. Defaults to true; false plays a harness that just drops the call.
   */
  mcpCancel?: boolean;
  /** How long the TUI takes to start before its first hook, as on a slow machine. Defaults to 0. */
  startDelayMs?: number;
  /** A line the TUI prints before exiting 1 as it starts, before its first hook: a start that fails. None by default. */
  startFailure?: string;
  /** With `startFailure`: only the first start under `home` fails, the ones after it start as usual. Defaults to false. */
  startFailureOnce?: boolean;
  /** Fire no `SessionStart` as the session starts, its other hooks running as usual. Defaults to false. */
  noSessionStart?: boolean;
  /** The source its `SessionStart` names, as Claude's after a compaction does `compact`. Defaults to its own (`startup`, `resume`). */
  sessionStartSource?: string;
  /**
   * How many Enters typed after text to lose, as a slow machine's TUI loses one that lands before it has taken the text
   * in: the text stays at the prompt until the next Enter. Defaults to 0.
   */
  loseEnters?: number;
  /** How many lines typed with text, the first prompt typed at it among them, lose no Enter before those start. Defaults to 0. */
  loseEntersAfter?: number;
  /**
   * How many prompts typed at the fake (not given on its command line) fire no `UserPromptSubmit`, as a hook that timed
   * out on a loaded machine; the turn runs all the same. Defaults to 0.
   */
  losePromptHooks?: number;
  /**
   * What Claude shows once a turn hits its usage limit: `continue` at its prompt (`prompt`), or its menu (`menu`, or
   * `menu-credits-first` with its usage-credits row first). None by default: just the error.
   */
  rateLimitScreen?: 'prompt' | 'menu' | 'menu-credits-first';
  /** The environment to start from. Defaults to the process's own, less the session variables of an enclosing board. */
  base?: NodeJS.ProcessEnv;
}

/** Environment that makes `claude` and `codex` resolve to the fakes and keeps them out of the real ~/.claude and ~/.codex. */
export function fakeHarnessEnv(options: FakeHarnessEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.base ? { ...options.base } : scrubBoardSessionEnv({ ...process.env });
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return {
    ...env,
    PATH: [fakeBinDir, env.PATH].filter(Boolean).join(delimiter),
    HOME: options.home,
    FAKE_HARNESS_SCENARIO: options.scenario,
    FAKE_HARNESS_STEP_DELAY_MS: String(options.stepDelayMs ?? 0),
    FAKE_HARNESS_IDLE_NOTIFY_MS: String(options.idleNotifyMs ?? 0),
    FAKE_HARNESS_TYPE_MS: String(options.typeMs ?? 0),
    FAKE_HARNESS_REPEAT: options.repeat ? '1' : '0',
    FAKE_HARNESS_MCP_CANCEL: options.mcpCancel === false ? '0' : '1',
    FAKE_HARNESS_START_DELAY_MS: String(options.startDelayMs ?? 0),
    FAKE_HARNESS_START_FAIL: options.startFailure ?? '',
    FAKE_HARNESS_START_FAIL_ONCE: options.startFailureOnce ? '1' : '0',
    FAKE_HARNESS_NO_SESSION_START: options.noSessionStart ? '1' : '0',
    FAKE_HARNESS_START_SOURCE: options.sessionStartSource ?? '',
    FAKE_HARNESS_LOSE_ENTERS: String(options.loseEnters ?? 0),
    FAKE_HARNESS_LOSE_ENTERS_AFTER: String(options.loseEntersAfter ?? 0),
    FAKE_HARNESS_LOSE_PROMPT_HOOKS: String(options.losePromptHooks ?? 0),
    FAKE_HARNESS_RATE_LIMIT_SCREEN: options.rateLimitScreen ?? '',
  };
}

export {
  startHookRecorder,
  claudeHookSettings,
  codexHooksJson,
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  type HookRecorder,
  type HookResponder,
  type HookEvent,
} from './recorder.ts';

export { McpClient, type McpServerConfig, type McpToolResult } from './mcp.ts';
