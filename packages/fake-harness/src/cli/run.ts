import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../hooks.ts';
import type { HarnessName } from '../paths.ts';
import { isScenario, play, SCENARIOS } from '../scenarios.ts';
import { FakeSession, type Invocation } from '../session.ts';

/**
 * Shared entry point for the fake binaries. Bad flags or config exit 2 with a one-line message, so a misconfigured
 * test never looks like the `crash` scenario (exit 1).
 */
export async function runFakeCli(harness: HarnessName, invoke: () => Invocation): Promise<void> {
  let invocation: Invocation;
  try {
    invocation = invoke();
  } catch (error) {
    if (error instanceof ConfigError) fail(harness, error.message);
    throw error;
  }
  if ('reply' in invocation) {
    process[invocation.stream ?? 'stdout'].write(`${invocation.reply}\n`);
    process.exitCode = invocation.exitCode ?? 0;
    return;
  }
  for (const warning of invocation.warnings ?? []) process.stderr.write(`${harness}: ${warning}\n`);
  const scenario = process.env.FAKE_HARNESS_SCENARIO ?? 'output';
  if (!isScenario(scenario)) fail(harness, `unknown FAKE_HARNESS_SCENARIO "${scenario}" (expected one of ${SCENARIOS.join(', ')})`);
  await boot(harness, invocation.prompt);
  const session = new FakeSession({
    ...invocation.dialect,
    stepDelayMs: Number(process.env.FAKE_HARNESS_STEP_DELAY_MS ?? 0),
    idleNotifyMs: Number(process.env.FAKE_HARNESS_IDLE_NOTIFY_MS ?? 0),
    typeMs: Number(process.env.FAKE_HARNESS_TYPE_MS ?? 0),
    demo: scenario.startsWith('demo-'),
  });
  await play(session, scenario, invocation.prompt, process.env.FAKE_HARNESS_REPEAT === '1');
}

function fail(harness: HarnessName, message: string): never {
  process.stderr.write(`${harness}: ${message}\n`);
  process.exit(2);
}

/**
 * What the TUI does before its session starts: prints a boot line and, with `FAKE_HARNESS_START_DELAY_MS`, takes that
 * long, as a slow machine does; with `FAKE_HARNESS_START_FAIL`, prints the first line of the task it was given, then
 * that, and exits 1 before its first hook. With `FAKE_HARNESS_START_FAIL_ONCE=1` too, only the first start under its
 * `HOME` fails: the ones after start as usual.
 */
async function boot(harness: HarnessName, prompt: string | undefined): Promise<void> {
  const delayMs = Number(process.env.FAKE_HARNESS_START_DELAY_MS ?? 0);
  const failure = process.env.FAKE_HARNESS_START_FAIL && !failedOnceBefore() ? process.env.FAKE_HARNESS_START_FAIL : undefined;
  if (delayMs <= 0 && !failure) return;
  process.stdout.write(`${harness} is starting\r\n`);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (failure) {
    if (prompt !== undefined) process.stdout.write(`task: ${prompt.split('\n', 1)[0]}\r\n`);
    process.stdout.write(`${failure}\r\n`);
    process.exit(1);
  }
}

/** Whether a start that fails only once has failed already under this `HOME`; marks this start as that one if not. */
function failedOnceBefore(): boolean {
  if (process.env.FAKE_HARNESS_START_FAIL_ONCE !== '1') return false;
  const marker = join(process.env.HOME ?? homedir(), '.fake-harness-start-failed');
  if (existsSync(marker)) return true;
  writeFileSync(marker, '');
  return false;
}
