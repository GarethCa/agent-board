import { gitGuardGlobalSetup, harnessGuardGlobalSetup, scrubBoardEnv } from '@agent-board/fake-harness';
import { createFakeGitHub } from '@agent-board/tracker/testing';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { daemonsServing, registeredDataDirs, removeDataDir, tempDataDir, terminate } from './launch.ts';

/**
 * The launched app inherits the guarded PATH, so anything it spawns as `claude`/`codex` hits a tripwire and fails the
 * run. It also inherits a throwaway app-data dir, so a test that forgets `launchApp` still never starts a daemon in
 * the real one, and tracker settings that keep it off Linear, GitHub and the keychain. It inherits no `AGENT_BOARD_*`
 * but these and the run knobs: run from inside an agent on a live board, the app would otherwise talk to that board.
 */
export default function globalSetup(): () => Promise<void> {
  // The electron package downloads its binary on first require. Do it once here: left to the test workers, two of
  // them race to unpack the same Electron.app and one launches a half-installed binary ("Process failed to launch!").
  createRequire(import.meta.url)('electron');
  scrubBoardEnv();
  const teardownGuard = harnessGuardGlobalSetup();
  // git in a spec must not see a GIT_DIR from the run's own environment, and the dev repo's core config must come out as it went in.
  const teardownGit = gitGuardGlobalSetup();
  const dataDir = tempDataDir();
  process.env.AGENT_BOARD_DATA_DIR = dataDir;
  // No app under test reaches the real Linear or the user's keychain: tests that need them pass a fixture server and
  // a throwaway keychain (see trackers.spec.ts); everyone else gets a dead port and a keychain file that isn't there.
  process.env.AGENT_BOARD_LINEAR_API_URL = 'http://127.0.0.1:9/graphql';
  process.env.AGENT_BOARD_KEYCHAIN = join(dataDir, 'no.keychain-db');
  // Onboarding opens by itself on an empty board, which every test starts with: only onboarding.spec.ts wants it.
  process.env.AGENT_BOARD_ONBOARDING = '0';
  // Nor the real gh, which the daemon asks for every agent's pull requests: a fake one, with no pull requests.
  const github = createFakeGitHub();
  process.env.AGENT_BOARD_GH = github.gh;
  return async () => {
    github.dispose();
    // Every test reaps its own daemons (see `test` in launch.ts); a survivor would run on for hours, so fail the run.
    const left = daemonsServing(registeredDataDirs(dataDir));
    await terminate(left);
    await removeDataDir(dataDir);
    teardownGuard();
    teardownGit();
    if (left.length > 0) throw new Error(`e2e daemons outlived their run: ${left.join(', ')}`);
  };
}
