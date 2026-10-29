import { delimiter } from 'node:path';
import { fakeBinDir } from './paths.ts';
import { scrubBoardSessionEnv } from './board-guard.ts';
import type { CodexStartScreen } from './codex-screens.ts';
import type { FakeScenario } from './scenarios.ts';

export { fakeBinDir } from './paths.ts';
export { SCENARIOS, type FakeScenario } from './scenarios.ts';
export { installHarnessGuard, harnessGuardGlobalSetup, guardChildProcess, realHarnessFor, type HarnessGuard } from './guard.ts';
export { BOARD_SESSION_VARS, RUN_KNOBS, scrubBoardSessionEnv, scrubBoardEnv } from './board-guard.ts';
export { REPO_GIT_VARS, leakedGitVars, scrubGitEnv, gitGuardGlobalSetup, assertCoreConfigUnchanged, coreConfigOf } from './git-guard.ts';
export { HARNESS_NAMES, type HarnessName } from './paths.ts';
export { CODEX_START_SCREENS, type CodexStartScreen } from './codex-screens.ts';
export {
  RATE_LIMIT_CONTINUE,
  RATE_LIMIT_CREDITS_ROW,
  RATE_LIMIT_MENU_TITLE,
  RATE_LIMIT_STOP_ROW,
  RATE_LIMIT_UPGRADE_ROW,
  drawRateLimitMenu,
  rateLimitMenuRows,
} from './rate-limit-menu.ts';
export { SPINNER_LINE, TRUST_NO_ROW, TRUST_YES_ROW, drawPromptBox, drawTrustScreen } from './trust-screen.ts';

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
  /**
   * The startup screen the fake Codex shows over its composer before its session is up (`folder-trust`,
   * `hooks-review`), until Enter answers it. None by default.
   */
  startScreen?: CodexStartScreen;
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
  /** How many turns end with no `Stop` hook, as a hook lost on a loaded machine; the turn ends all the same. Defaults to 0. */
  loseStopHooks?: number;
  /** How long a session that quits waits after its `SessionEnd` before it exits, still reading what is typed. Defaults to 0. */
  sessionEndExitMs?: number;
  /**
   * With more than 0, an idle Claude session compacts its conversation once it has sat at its prompt this long, as
   * Claude's idle compaction does: `PreCompact`, then a `SessionStart` from `compact`, and no turn. Defaults to 0: never.
   */
  idleCompactMs?: number;
  /**
   * With more than 0, an idle Claude session says another session needs your input (`agent_needs_input`) once it has
   * sat at its prompt this long, as Claude does of the background sessions it tracks. Defaults to 0: never.
   */
  idleNeedsInputMs?: number;
  /** The message of that `agent_needs_input` instead of another session's: one of Claude's own dialogs, by its text. */
  idleNeedsInputMessage?: string;
  /** With `idleNeedsInputMs`: that dialog is closed in its terminal this long after it opens, its prompt box drawn, no hook. */
  dialogCloseMs?: number;
  /**
   * Claude draws its prompt box each time it sits at its prompt, as the real TUI shows between turns; with `spinner`,
   * under its turn's spinner line (`SPINNER_LINE`), as Claude still shows while work it started goes on. Defaults to false.
   */
  promptBox?: boolean | 'spinner';
  /**
   * Its turn's first tool call never returns, printing nothing more (its prompt box drawn under it with `promptBox`), as
   * a long silent command under reduced motion, where Claude stops redrawing. Defaults to false.
   */
  hangTool?: boolean;
  /**
   * Take keys as they come rather than a line at a time, as the real TUIs do, so a line longer than a terminal's 1 KiB
   * line arrives; Claude then keeps only the bytes after the last whole KiB of a long line typed with no paste around it,
   * as Claude 2.1.312 did. Defaults to false.
   */
  rawInput?: boolean;
  /**
   * What Claude shows once a turn hits its usage limit: `continue` at its prompt (`prompt`), or its menu (`menu`, or
   * `menu-credits-first` with its usage-credits row first). None by default: just the error.
   */
  rateLimitScreen?: 'prompt' | 'menu' | 'menu-credits-first';
  /**
   * The plan usage Claude passes its status line, as its `rate_limits`: with it, Claude runs the status line its
   * `--settings` give after each turn. None by default, and then no status line runs.
   */
  rateLimits?: Record<string, unknown>;
  /**
   * Show Claude's folder-trust screen as the session starts, firing no hook until it is answered, as Claude does in a
   * folder it has never opened; with `late-start`, its `SessionStart` only comes as the first keys are typed at the
   * prompt it draws then, landing before the Enter after them; with `slow-prompt`, a line of its own shows for a second
   * before that prompt; with `slow-redraw`, the screen stays drawn a while after Enter picks its yes row; with `stuck-pointer`,
   * Down never moves its pointer. Defaults to false.
   */
  trustScreen?: boolean | 'late-start' | 'slow-prompt' | 'slow-redraw' | 'stuck-pointer';
  /**
   * Take a message typed while a turn runs at the turn's next step after a tool call, writing it to the transcript as a
   * `queued_command` attachment, as Claude Code 2.1 does (Claude only). Defaults to false: it is the next prompt, a
   * turn of its own once this one ends.
   */
  queueMidTurn?: boolean;
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
    FAKE_HARNESS_START_SCREEN: options.startScreen ?? '',
    FAKE_HARNESS_NO_SESSION_START: options.noSessionStart ? '1' : '0',
    FAKE_HARNESS_START_SOURCE: options.sessionStartSource ?? '',
    FAKE_HARNESS_LOSE_ENTERS: String(options.loseEnters ?? 0),
    FAKE_HARNESS_LOSE_ENTERS_AFTER: String(options.loseEntersAfter ?? 0),
    FAKE_HARNESS_LOSE_PROMPT_HOOKS: String(options.losePromptHooks ?? 0),
    FAKE_HARNESS_RAW_INPUT: options.rawInput ? '1' : '0',
    FAKE_HARNESS_LOSE_STOP_HOOKS: String(options.loseStopHooks ?? 0),
    FAKE_HARNESS_SESSION_END_EXIT_MS: String(options.sessionEndExitMs ?? 0),
    FAKE_HARNESS_IDLE_COMPACT_MS: String(options.idleCompactMs ?? 0),
    FAKE_HARNESS_IDLE_NEEDS_INPUT_MS: String(options.idleNeedsInputMs ?? 0),
    FAKE_HARNESS_IDLE_NEEDS_INPUT_MESSAGE: options.idleNeedsInputMessage ?? '',
    FAKE_HARNESS_DIALOG_CLOSE_MS: String(options.dialogCloseMs ?? 0),
    FAKE_HARNESS_PROMPT_BOX: options.promptBox === 'spinner' ? 'spinner' : options.promptBox ? '1' : '0',
    FAKE_HARNESS_HANG_TOOL: options.hangTool ? '1' : '0',
    FAKE_HARNESS_RATE_LIMIT_SCREEN: options.rateLimitScreen ?? '',
    FAKE_HARNESS_QUEUE_MID_TURN: options.queueMidTurn ? '1' : '0',
    FAKE_HARNESS_RATE_LIMITS: options.rateLimits === undefined ? '' : JSON.stringify(options.rateLimits),
    FAKE_HARNESS_TRUST_SCREEN: typeof options.trustScreen === 'string' ? options.trustScreen : options.trustScreen ? '1' : '0',
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
