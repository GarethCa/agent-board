import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readTestOverrides } from '../src/test-overrides.ts';
import { startTestDaemon, tempDataDir } from './helpers.ts';

const ENV = {
  AGENT_BOARD_HOOK_SHIM: '/tmp/shim',
  AGENT_BOARD_PULL_REQUEST_POLL_MS: '1',
  AGENT_BOARD_LINEAR_API_URL: 'http://127.0.0.1:9/graphql',
  AGENT_BOARD_GH: '/tmp/fake-gh',
  AGENT_BOARD_KEYCHAIN: '/tmp/test.keychain',
  AGENT_BOARD_LINK_FETCH_HTML: '/tmp/page.html',
};

describe("the daemon's test overrides", () => {
  it('are read from the environment when honoured, as in tests and a daemon run from source', () => {
    expect(readTestOverrides(true, ENV)).toEqual({
      linearApiUrl: 'http://127.0.0.1:9/graphql',
      gh: '/tmp/fake-gh',
      keychain: '/tmp/test.keychain',
      linkFetchHtml: '/tmp/page.html',
      hookShim: '/tmp/shim',
      pullRequestPollMs: 1,
    });
  });

  it('read the timing knobs as numbers, and the harness folders as a list', () => {
    const overrides = readTestOverrides(true, { AGENT_BOARD_PULL_REQUEST_POLL_MS: '50', AGENT_BOARD_START_LIMIT_MS: 'soon', AGENT_BOARD_HARNESS_DIRS: `/a${delimiter}${delimiter}/b`, AGENT_BOARD_LOGIN_SHELL: '0' });
    expect(overrides).toMatchObject({ pullRequestPollMs: 50, startLimitMs: undefined, harnessDirs: ['/a', '/b'], noLoginShell: true });
  });

  it("are ignored by a packaged app's daemon, so its Linear key goes only to Linear", () => {
    expect(readTestOverrides(false, ENV)).toEqual({});
  });

  it('take an empty value as no override', () => {
    expect(readTestOverrides(true, { AGENT_BOARD_GH: '' }).gh).toBeUndefined();
  });
});

describe('a daemon', () => {
  /** Starts a daemon with `$AGENT_BOARD_EXTERNAL_HOOK_FILE` set, and says where it left its address for external hooks. */
  async function externalHookFileOf(testOverrides: boolean) {
    const dir = tempDataDir();
    const override = join(dir, 'override', 'external-hook.json');
    const previous = process.env.AGENT_BOARD_EXTERNAL_HOOK_FILE;
    process.env.AGENT_BOARD_EXTERNAL_HOOK_FILE = override;
    onTestFinished(() => {
      if (previous === undefined) delete process.env.AGENT_BOARD_EXTERNAL_HOOK_FILE;
      else process.env.AGENT_BOARD_EXTERNAL_HOOK_FILE = previous;
    });
    // No external hook file of its own, so the daemon picks one: the override, or the one beside the shim's folder.
    await startTestDaemon({ testOverrides, hookShimPath: join(dir, 'bin', 'agent-board-hook'), externalHookFile: undefined });
    return { atOverride: existsSync(override), atDefault: existsSync(join(dir, 'external-hook.json')) };
  }

  it('honours the environment overrides by default', async () => {
    expect(await externalHookFileOf(true)).toEqual({ atOverride: true, atDefault: false });
  });

  it('ignores them when told to, as a packaged app has it', async () => {
    expect(await externalHookFileOf(false)).toEqual({ atOverride: false, atDefault: true });
  });
});
