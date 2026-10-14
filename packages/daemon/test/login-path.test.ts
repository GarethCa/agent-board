import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptLoginShellPath, loginShellKind, loginShellPath, mergePath } from '../src/login-path.ts';
import { tempDataDir } from './helpers.ts';

/** launchd's PATH: what a daemon started from an app opened in the Dock or Finder has. */
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** A home whose `~/.profile` puts a `bin` dir on PATH, as Homebrew's setup does, and that dir. */
function homeWithProfile(profile = (bin: string) => `export PATH="${bin}:$PATH"\n`) {
  const home = tempDataDir();
  const bin = join(home, 'brew', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho fake\n');
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(home, '.profile'), profile(bin));
  return { home, bin };
}

describe("the login shell's PATH", () => {
  it("is read from the user's login shell, profile and all, even from a daemon with launchd's bare PATH", async () => {
    const { home, bin } = homeWithProfile((dir) => `echo "welcome back"\nexport PATH="${dir}:$PATH"\n`);
    const path = await loginShellPath('/bin/sh', ['-l'], { env: { HOME: home, PATH: BARE_PATH } });
    expect(path?.split(':')).toContain(bin);
    // Whatever the profile printed is not part of it.
    expect(path).not.toContain('welcome');
  });

  it('is undefined for sessions without a login shell, or a shell whose syntax is unknown', async () => {
    const { home } = homeWithProfile();
    expect(await loginShellPath('/bin/sh', [], { env: { HOME: home, PATH: BARE_PATH } })).toBeUndefined();
    expect(await loginShellPath('/usr/bin/nu', ['-l'], { env: { HOME: home, PATH: BARE_PATH } })).toBeUndefined();
    expect(loginShellKind('/opt/homebrew/bin/fish', ['-l'])).toBe('fish');
    expect(loginShellKind('/bin/zsh', ['-l'])).toBe('posix');
  });

  it('gives up on a profile that hangs, or a shell that fails, and the daemon keeps its own PATH', async () => {
    const { home } = homeWithProfile(() => 'sleep 30\n');
    const started = Date.now();
    expect(await loginShellPath('/bin/sh', ['-l'], { env: { HOME: home, PATH: BARE_PATH }, timeoutMs: 300 })).toBe(
      undefined,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    const broken = homeWithProfile(() => 'exit 3\n');
    expect(await loginShellPath('/bin/sh', ['-l'], { env: { HOME: broken.home, PATH: BARE_PATH } })).toBeUndefined();
  });

  it('is adopted into the env every CLI the daemon runs starts from, so gh is found there', async () => {
    const { home, bin } = homeWithProfile();
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: BARE_PATH };
    await adoptLoginShellPath('/bin/sh', ['-l'], env);
    expect(env.PATH?.split(':')[0]).toBe(bin);
    expect(execFileSync('gh', [], { env, encoding: 'utf8' })).toBe('fake\n');

    // Without a login shell, the env keeps its PATH.
    const plain: NodeJS.ProcessEnv = { HOME: home, PATH: BARE_PATH };
    await adoptLoginShellPath('/bin/sh', [], plain);
    expect(plain.PATH).toBe(BARE_PATH);
  });

  it("puts the login shell's dirs first and keeps the daemon's others after them, once each", () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
    );
    expect(mergePath(undefined, BARE_PATH)).toBe(BARE_PATH);
  });
});
