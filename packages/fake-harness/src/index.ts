import { delimiter } from 'node:path';
import { fakeBinDir } from './paths.ts';
import type { FakeScenario } from './scenarios.ts';

export { fakeBinDir } from './paths.ts';
export { SCENARIOS, type FakeScenario } from './scenarios.ts';
export { installHarnessGuard, harnessGuardGlobalSetup, guardChildProcess, realHarnessFor, type HarnessGuard } from './guard.ts';
export { HARNESS_NAMES, type HarnessName } from './paths.ts';

export interface FakeHarnessEnvOptions {
  scenario: FakeScenario;
  /** Home directory the fakes treat as `~` (where `~/.claude` and `~/.codex` live). Use a temp dir. */
  home: string;
  /** Pause between streamed words and tool steps. Defaults to 0. */
  stepDelayMs?: number;
  /** How long an idle Claude session waits before firing `idle_prompt`. Defaults to 0; the real CLI waits about 60 s. */
  idleNotifyMs?: number;
  /** Replay the scenario for every later prompt too, instead of a plain turn. Defaults to false. */
  repeat?: boolean;
  base?: NodeJS.ProcessEnv;
}

/** Environment that makes `claude` and `codex` resolve to the fakes and keeps them out of the real ~/.claude and ~/.codex. */
export function fakeHarnessEnv(options: FakeHarnessEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return {
    ...env,
    PATH: [fakeBinDir, env.PATH].filter(Boolean).join(delimiter),
    HOME: options.home,
    FAKE_HARNESS_SCENARIO: options.scenario,
    FAKE_HARNESS_STEP_DELAY_MS: String(options.stepDelayMs ?? 0),
    FAKE_HARNESS_IDLE_NOTIFY_MS: String(options.idleNotifyMs ?? 0),
    FAKE_HARNESS_REPEAT: options.repeat ? '1' : '0',
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
