import { appendFileSync, chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarnessPaths } from '../src/harness-path.ts';
import { loginShellPath } from '../src/login-path.ts';
import { tempDataDir } from './helpers.ts';

const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** A fake home. zsh reads its `.zshrc` from `ZDOTDIR`, so that is the temp home too. */
function fakeHome() {
  const home = tempDataDir();
  const env: NodeJS.ProcessEnv = { HOME: home, ZDOTDIR: home, PATH: BARE_PATH };
  // Starts from the bare PATH, so the harness guard's tripwires (which it adds to every child's PATH) are not on it.
  writeFileSync(join(home, '.zshrc'), `export PATH="${BARE_PATH}"\n`);
  return { home, env };
}

/** An executable named `name` in `dir`, made. */
function fakeBinary(dir: string, name = 'claude'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\necho fake\n');
  chmodSync(file, 0o755);
  return file;
}

const zsh = (env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof createHarnessPaths>[0]> = {}) =>
  createHarnessPaths({ shell: '/bin/zsh', shellArgs: ['-l'], env, homeDir: env.HOME!, knownDirs: [], timeoutMs: 5_000, ...extra });

describe('the interactive login shell PATH', () => {
  it('has what .zshrc sets, which the non-interactive login shell never reads', async () => {
    const { home, env } = fakeHome();
    appendFileSync(join(home, '.zshrc'), 'export PATH="/from/zshrc:$PATH"\n');
    expect(await loginShellPath('/bin/zsh', ['-l'], { env })).not.toContain('/from/zshrc');
    expect(await loginShellPath('/bin/zsh', ['-l'], { env, interactive: true })).toContain('/from/zshrc');
  });

  it('is not hung or polluted by an rc file that prints or reads', async () => {
    const { home, env } = fakeHome();
    appendFileSync(join(home, '.zshrc'), 'echo "hello there"\nread -r answer\nexport PATH="/from/zshrc:$PATH"\n');
    const path = await loginShellPath('/bin/zsh', ['-l'], { env, interactive: true });
    expect(path).toContain('/from/zshrc');
    expect(path).not.toContain('hello');
  });

  it('is not held up by a job the rc file leaves running, which keeps the shell\'s output open', async () => {
    const { home, env } = fakeHome();
    appendFileSync(join(home, '.zshrc'), '(sleep 20 &)\nexport PATH="/from/zshrc:$PATH"\n');
    const started = Date.now();
    expect(await loginShellPath('/bin/zsh', ['-l'], { env, interactive: true })).toContain('/from/zshrc');
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

describe('finding a harness', () => {
  it('finds it on the PATH it is given', async () => {
    const { home, env } = fakeHome();
    const file = fakeBinary(join(home, 'bin'));
    env.PATH = `${join(home, 'bin')}:${BARE_PATH}`;
    const paths = zsh(env);
    expect(paths.path('claude')).toBe(file);
  });

  it('finds one reachable only through .zshrc, as an absolute path', async () => {
    const { home, env } = fakeHome();
    const file = fakeBinary(join(home, 'rc-bin'));
    appendFileSync(join(home, '.zshrc'), `export PATH="${join(home, 'rc-bin')}:$PATH"\n`);
    const paths = zsh(env);
    expect(paths.path('claude')).toBeUndefined();
    expect(await paths.refresh('claude')).toBe(file);
    expect(paths.path('claude')).toBe(file);
  });

  it('finds an alias-only install in the places the installers use', async () => {
    const { home, env } = fakeHome();
    const file = fakeBinary(join(home, '.claude', 'local'));
    appendFileSync(join(home, '.zshrc'), `alias claude=${file}\n`);
    expect(await zsh(env, { knownDirs: [join(home, '.claude', 'local')] }).refresh('claude')).toBe(file);
    // Through the real known list, which is under the home.
    expect(await zsh(env, { knownDirs: undefined }).refresh('claude')).toBe(file);
  });

  it('finds Codex in the same way, by its own name', async () => {
    const { home, env } = fakeHome();
    const file = fakeBinary(join(home, '.local', 'bin'), 'codex');
    expect(await zsh(env, { knownDirs: undefined }).refresh('codex')).toBe(file);
  });

  it('is undefined when nothing is found, and names what is missing', async () => {
    const { env } = fakeHome();
    const paths = zsh(env);
    expect(await paths.refresh('claude')).toBeUndefined();
    expect(paths.notFound('claude')).toBe('claude not found on this Mac: install it, or set its path in Settings');
  });

  it('skips a directory or a file that is not executable', async () => {
    const { home, env } = fakeHome();
    mkdirSync(join(home, 'dir', 'claude'), { recursive: true });
    mkdirSync(join(home, 'plain'));
    writeFileSync(join(home, 'plain', 'claude'), '#!/bin/sh\n');
    expect(await zsh(env, { knownDirs: [join(home, 'dir'), join(home, 'plain')] }).refresh('claude')).toBeUndefined();
  });

  it('follows a symlink to the file, and returns the path it was found at', async () => {
    const { home, env } = fakeHome();
    const target = fakeBinary(join(home, 'versions'), '2.1.0');
    mkdirSync(join(home, 'known'));
    symlinkSync(target, join(home, 'known', 'claude'));
    expect(await zsh(env, { knownDirs: [join(home, 'known')] }).refresh('claude')).toBe(join(home, 'known', 'claude'));
  });

  it('forgets a path that is gone, and looks again on refresh', async () => {
    const { home, env } = fakeHome();
    const first = fakeBinary(join(home, 'one'));
    const second = fakeBinary(join(home, 'two'));
    const dirs = [join(home, 'one'), join(home, 'two')];
    const paths = zsh(env, { knownDirs: dirs });
    expect(await paths.refresh('claude')).toBe(first);
    chmodSync(first, 0o644);
    expect(paths.path('claude')).toBeUndefined();
    expect(await paths.refresh('claude')).toBe(second);
  });
});

describe('the path set in Settings', () => {
  it('is used ahead of the lookup', async () => {
    const { home, env } = fakeHome();
    fakeBinary(join(home, 'known'));
    const chosen = fakeBinary(join(home, 'mine'));
    const paths = zsh(env, { knownDirs: [join(home, 'known')], override: () => chosen });
    expect(paths.path('claude')).toBe(chosen);
    expect(await paths.refresh('claude')).toBe(chosen);
  });

  it('is forgotten when cleared: the lookup comes back at once', async () => {
    const { home, env } = fakeHome();
    const known = fakeBinary(join(home, 'known'));
    const chosen = fakeBinary(join(home, 'mine'));
    let set: string | undefined = chosen;
    const paths = zsh(env, { knownDirs: [join(home, 'known')], override: () => set });
    expect(await paths.refresh('claude')).toBe(chosen);
    set = undefined;
    expect(paths.path('claude')).toBeUndefined();
    expect(await paths.refresh('claude')).toBe(known);
  });

  it('is not replaced by the lookup when it is wrong, and the message names it', async () => {
    const { home, env } = fakeHome();
    fakeBinary(join(home, 'known'));
    const paths = zsh(env, { knownDirs: [join(home, 'known')], override: () => join(home, 'typo') });
    expect(paths.path('claude')).toBeUndefined();
    expect(await paths.refresh('claude')).toBeUndefined();
    expect(paths.notFound('claude')).toBe(`claude not found at ${join(home, 'typo')}: fix its path in Settings, or clear it`);
  });
});

describe('the environment a harness runs in', () => {
  it('has the interactive shell\'s PATH, so a script harness finds the interpreter .zshrc puts on it', async () => {
    const { home, env } = fakeHome();
    const rc = join(home, 'rc-bin');
    fakeBinary(rc, 'node');
    appendFileSync(join(home, '.zshrc'), `export PATH="${rc}:$PATH"\n`);
    const claude = fakeBinary(join(home, '.claude', 'local'));
    const paths = zsh(env, { knownDirs: undefined });
    expect(await paths.refresh('claude')).toBe(claude);
    const launchEnv = paths.launchEnv({ ...env, PATH: BARE_PATH });
    expect(launchEnv.PATH?.split(':')).toContain(rc);
    expect(launchEnv.HOME).toBe(home);
    expect(launchEnv.PATH?.split(':')).toEqual(expect.arrayContaining(BARE_PATH.split(':')));
  });

  it('is unchanged when no interactive PATH was read', () => {
    const { env } = fakeHome();
    expect(zsh(env).launchEnv(env)).toEqual(env);
  });
});
