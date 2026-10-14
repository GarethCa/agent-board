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
  const session = new FakeSession({
    ...invocation.dialect,
    stepDelayMs: Number(process.env.FAKE_HARNESS_STEP_DELAY_MS ?? 0),
    idleNotifyMs: Number(process.env.FAKE_HARNESS_IDLE_NOTIFY_MS ?? 0),
  });
  await play(session, scenario, invocation.prompt, process.env.FAKE_HARNESS_REPEAT === '1');
}

function fail(harness: HarnessName, message: string): never {
  process.stderr.write(`${harness}: ${message}\n`);
  process.exit(2);
}
