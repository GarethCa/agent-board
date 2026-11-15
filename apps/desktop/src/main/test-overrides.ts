// Whether this run honours the environment's test overrides: the fake daemon build, the daemon's timeouts, headless
// windows, the fake notifier, the pinned theme, the Accept wait and the daemon's own fakes and timings (`@agent-board/daemon`'s test-overrides.ts). A packaged app ignores them unless
// `AGENT_BOARD_TEST=1`, which the e2e launches set, so nothing in its environment can change what it trusts.

/**
 * Whether `execPath` is a packaged app rather than the `electron` binary a dev build runs on: Electron's own rule for
 * `app.isPackaged`, for the daemon's entry, which runs as Node and has no `app`.
 */
export function isPackagedExecutable(execPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const file = (execPath.split(/[\\/]/).pop() ?? '').toLowerCase();
  return file !== (platform === 'win32' ? 'electron.exe' : 'electron');
}

/**
 * What the daemon's entry (`main/daemon.ts`, the app's executable run as Node) takes from its environment: whether it
 * honours test overrides, and the build a test has it claim (`AGENT_BOARD_FAKE_DAEMON_BUILD`), if any.
 */
export function daemonEntryOverrides(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { testOverrides: boolean; fakeBuild: string | undefined } {
  const testOverrides = honoursTestOverrides(isPackagedExecutable(execPath), env);
  return { testOverrides, fakeBuild: testOverrides ? env.AGENT_BOARD_FAKE_DAEMON_BUILD || undefined : undefined };
}

/** True in a dev build, and in a packaged one only when `AGENT_BOARD_TEST=1`. */
export function honoursTestOverrides(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !packaged || env.AGENT_BOARD_TEST === '1';
}
