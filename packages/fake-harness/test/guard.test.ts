import { afterAll, describe, expect, it } from 'vitest';
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBinDir, fakeHarnessEnv, type HarnessName } from '../src/index.ts';
import { removeTempDirs, tempDir } from './run-fake.ts';

afterAll(removeTempDirs);

/** Stands in for a real install, e.g. ~/.local/bin/claude. Never actually run. */
function pretendRealInstall(name: HarnessName): string {
  const path = join(tempDir('real-bin-'), name);
  writeFileSync(path, '#!/bin/sh\necho REAL HARNESS RAN\n');
  chmodSync(path, 0o755);
  return path;
}

describe('harness guard', () => {
  it('refuses to spawn claude or codex from a plain test environment', () => {
    expect(() => spawnSync('claude', ['--version'])).toThrow(/real claude/);
    expect(() => spawn('codex', ['--version'])).toThrow(/real codex/);
    expect(() => execFileSync('claude')).toThrow(/real claude/);
  });

  it('refuses a real binary reached by absolute path', () => {
    const real = pretendRealInstall('claude');

    expect(() => execFile(real, () => {})).toThrow(/real claude/);
  });

  it('refuses a real binary found on a PATH passed in spawn options', () => {
    const real = pretendRealInstall('codex');

    expect(() => spawnSync('codex', { env: { PATH: join(real, '..') } })).toThrow(/real codex/);
  });

  it('refuses a real binary run through a shell that carries its own PATH', () => {
    const realDir = join(pretendRealInstall('claude'), '..');
    const env = { PATH: `${realDir}:/usr/bin:/bin` };

    expect(() => execFileSync('/bin/sh', ['-c', 'claude --version'], { env })).toThrow(/real claude/);
    expect(() => spawnSync('claude --version', { shell: true, env })).toThrow(/real claude/);
    expect(() => execSync('FOO=1 claude --version', { env })).toThrow(/real claude/);
    expect(() => exec(`echo hi && ${pretendRealInstall('codex')}`, { env }, () => {})).toThrow(/real codex/);
  });

  it('keeps the tripwire first on a PATH the caller rebuilt, so scripts it runs still hit it', () => {
    const realDir = join(pretendRealInstall('claude'), '..');
    const script = join(tempDir('script-'), 'run.sh');
    writeFileSync(script, 'command -v claude\n');

    const found = execFileSync('/bin/sh', [script], { env: { PATH: `${realDir}:/usr/bin:/bin` }, encoding: 'utf8' }).trim();

    expect(found).toBe(join(process.env.AGENT_BOARD_HARNESS_GUARD_DIR!, 'claude'));
  });

  it('still lets the fakes win when the caller put them on PATH', () => {
    const env = fakeHarnessEnv({ scenario: 'output', home: tempDir('fake-home-'), base: { PATH: '/usr/bin:/bin' } });

    const found = execFileSync('/bin/sh', ['-c', 'command -v claude'], { env, encoding: 'utf8' }).trim();

    expect(found).toBe(join(fakeBinDir, 'claude'));
  });

  it('leaves a caller env without PATH on the default system path, plus the tripwire', () => {
    const result = spawnSync('/bin/sh', ['-c', 'ls / > /dev/null && command -v claude'], { env: { FOO: '1' }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(process.env.AGENT_BOARD_HARNESS_GUARD_DIR!, 'claude'));
    expect(spawnSync('sh', ['-c', 'true'], { env: { FOO: '1' } }).error).toBeUndefined();
  });

  it('allows shell text that only mentions claude or codex outside command position', () => {
    const env = { PATH: `${join(pretendRealInstall('claude'), '..')}:/usr/bin:/bin` };

    expect(() => execSync('echo claude is great', { env })).not.toThrow();
    expect(() => execFileSync('/bin/sh', ['-c', 'echo x | grep -c claude || true'], { env })).not.toThrow();
    expect(() => execSync('command -v claude', { env })).not.toThrow();
    expect(() => execSync('echo "run claude; then codex" > /dev/null', { env })).not.toThrow();
  });

  it('refuses claude or codex in command position anywhere in shell text', () => {
    const env = { PATH: `${join(pretendRealInstall('claude'), '..')}:/usr/bin:/bin` };

    for (const script of ['true && claude', 'echo $(claude -p hi)', 'X=1 Y=2 claude', 'exec claude', 'env FOO=1 claude', 'command claude', 'nohup claude &']) {
      expect(() => execSync(script, { env }), script).toThrow(/real claude/);
    }
  });

  it('refuses a harness launched through env with its own PATH assignment', () => {
    const realDir = join(pretendRealInstall('claude'), '..');

    expect(() => execFileSync('/usr/bin/env', [`PATH=${realDir}`, 'claude'])).toThrow(/real claude/);
    expect(() => execSync(`env PATH=${realDir} claude`)).toThrow(/real claude/);
  });

  it('fails the whole run when a real binary is reached where child_process cannot see it (inside a script file)', () => {
    const fixture = fileURLToPath(new URL('./fixtures/guard-escape', import.meta.url));
    const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));

    const result = spawnSync(process.execPath, [vitest, 'run', '--root', fixture], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/harness guard: .*claude/);
  }, 30_000);
});
