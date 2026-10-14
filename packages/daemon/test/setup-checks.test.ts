import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeBinDir } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { checkTool, parseVersion } from '../src/setup-checks.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

/** launchd's PATH, which has none of the CLIs. */
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** An empty `bin` dir first on a bare PATH, and a dir with only `node` in it, which the fakes run on. */
function bareEnv(extra: NodeJS.ProcessEnv = {}) {
  const dir = tempDataDir();
  const bin = join(dir, 'bin');
  const nodeBin = join(dir, 'node-bin');
  mkdirSync(bin);
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${nodeBin}:${BARE_PATH}`, HOME: dir, ...extra };
  /** Puts the fake `name` on that PATH, as installing the CLI would. */
  const install = (name: 'claude' | 'codex') => {
    symlinkSync(join(fakeBinDir, name), join(bin, name));
  };
  return { env, bin, install };
}

describe('a CLI check', () => {
  it('reads the version out of what --version prints', () => {
    expect(parseVersion('2.1.296 (Claude Code)\n')).toBe('2.1.296');
    expect(parseVersion('codex-cli 0.162.0-alpha.2')).toBe('0.162.0-alpha.2');
    expect(parseVersion('gh version 2.88.1 (2026-03-12)\nhttps://github.com/cli/cli/releases/tag/v2.88.1')).toBe('2.88.1');
    expect(parseVersion('no version here')).toBeUndefined();
  });

  it('finds nothing when the CLI is not on PATH', async () => {
    const { env } = bareEnv();
    expect(await checkTool('claude', { env })).toEqual({ tool: 'claude', found: false });
    expect(await checkTool('codex', { env })).toEqual({ tool: 'codex', found: false });
  });

  it('finds an installed harness, its version and whether it is signed in', async () => {
    const { env, bin, install } = bareEnv();
    install('claude');
    install('codex');
    expect(await checkTool('claude', { env })).toEqual({
      tool: 'claude',
      found: true,
      path: join(bin, 'claude'),
      version: '2.1.0',
      signedIn: true,
    });
    expect(await checkTool('codex', { env })).toMatchObject({ tool: 'codex', found: true, version: '0.46.0', signedIn: true });

    const signedOut = { ...env, FAKE_HARNESS_LOGGED_OUT: '1' };
    expect(await checkTool('claude', { env: signedOut })).toMatchObject({ found: true, signedIn: false });
    expect(await checkTool('codex', { env: signedOut })).toMatchObject({ found: true, signedIn: false });
  });

  it('checks gh at the path it is given, signed in or not', async () => {
    const { env } = bareEnv();
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, loggedIn: false });
    try {
      expect(await checkTool('gh', { env, gh: join(dirname(github.gh), 'missing-gh') })).toEqual({ tool: 'gh', found: false });
      expect(await checkTool('gh', { env, gh: github.gh })).toEqual({ tool: 'gh', found: true, path: github.gh, version: '2.0.0', signedIn: false });
      github.setState({ ...FAKE_GITHUB_STATE, loggedIn: true });
      expect(await checkTool('gh', { env, gh: github.gh })).toMatchObject({ found: true, signedIn: true });
    } finally {
      github.dispose();
    }
  });

  it('says a CLI that hangs or dies did not answer, never that it is signed in or out', async () => {
    const { env, bin } = bareEnv();
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
      return join(bin, name);
    };
    // Prints a version, then hangs when asked whether it is signed in.
    const hangs = script('gh-hangs', 'if [ "$1" = --version ]; then echo "gh version 2.0.0"; else exec sleep 30; fi');
    expect(await checkTool('gh', { env, gh: hangs, timeoutMs: 2_000 })).toEqual({
      tool: 'gh',
      found: true,
      path: hangs,
      version: '2.0.0',
      problem: 'did not answer in time',
    });
    // Killed by a signal: no exit code to read.
    const dies = script('gh-dies', 'kill -9 $$');
    expect(await checkTool('gh', { env, gh: dies })).toEqual({ tool: 'gh', found: true, path: dies, problem: 'could not be run' });
  });

  it('is answered by the daemon with its own PATH', async () => {
    const { env, install } = bareEnv();
    const client = await connectTestClient(await startTestDaemon({ agentEnv: env }));
    expect(await client.call('setup.check', { tool: 'claude' })).toEqual({ tool: 'claude', found: false });
    install('claude');
    expect(await client.call('setup.check', { tool: 'claude' })).toMatchObject({ found: true, signedIn: true });
    await expect(client.call('setup.check', { tool: 'git' as never })).rejects.toThrow(/tool must be one of/);
  });
});
