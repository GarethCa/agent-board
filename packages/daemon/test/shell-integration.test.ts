import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harnessOfProgram, listeningPorts } from '../src/foreground.ts';
import { lastExitStatus, shellIntegrationEnv } from '../src/shell-integration.ts';
import { tempDataDir } from './helpers.ts';

describe('shell integration', () => {
  it('reads the last exit status a chunk of output reported, and none from plain output', () => {
    expect(lastExitStatus('ls\r\n\x1b]6973;exit;0\x07$ ')).toBe(0);
    expect(lastExitStatus('\x1b]6973;exit;0\x07$ false\r\n\x1b]6973;exit;1\x07$ ')).toBe(1);
    expect(lastExitStatus('plain output')).toBeUndefined();
  });

  it("has bash put its report ahead of the user's own PROMPT_COMMAND, and knows nothing of fish", () => {
    expect(shellIntegrationEnv('/bin/bash', tempDataDir(), { PROMPT_COMMAND: 'history -a' }).PROMPT_COMMAND).toMatch(/^__ab_status=\$\?; .*; history -a$/);
    expect(shellIntegrationEnv('/opt/homebrew/bin/fish', tempDataDir(), {})).toEqual({});
  });

  it.runIf(existsSync('/bin/zsh'))("has zsh report each command's status, after the user's own startup files", () => {
    const home = tempDataDir();
    execFileSync('/bin/sh', ['-c', `printf 'export FROM_USER=yes\\n' > "${home}/.zshrc"`]);
    const env = { HOME: home, PATH: process.env.PATH ?? '' };
    const integration = shellIntegrationEnv('/bin/zsh', tempDataDir(), env);
    // An interactive zsh runs its precmd hooks before each prompt; -i with input from a pipe runs them too.
    const output = execFileSync('/bin/zsh', ['-i'], { env: { ...env, ...integration }, input: 'echo $FROM_USER\nfalse\nexit 0\n', encoding: 'utf8' });
    expect(output).toContain('yes');
    expect(output).toContain('\x1b]6973;exit;1\x07');
  });
});

describe("a zsh with the integration keeps the user's own settings", () => {
  /** `HISTFILE`, and a setting from the user's startup files, as zsh has them: plain or with the integration. */
  const settings = (home: string, integrated: boolean, login: boolean, user: Record<string, string> = {}) => {
    const env = { HOME: home, PATH: process.env.PATH ?? '', ...user };
    const extra = integrated ? shellIntegrationEnv('/bin/zsh', tempDataDir(), env) : {};
    const output = execFileSync('/bin/zsh', [login ? '-il' : '-i', '-c', 'print -r -- "$HISTFILE|$FROM_USER"'], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      input: '',
    });
    return output.split('\n').filter((line) => line.includes('|')).at(-1);
  };

  it.runIf(existsSync('/bin/zsh'))('has the same HISTFILE as a plain zsh, whether the user sets one or not, login or not', () => {
    const plain = tempDataDir();
    writeFileSync(join(plain, '.zshrc'), 'export FROM_USER=rc\n');
    const custom = tempDataDir();
    writeFileSync(join(custom, '.zshrc'), `HISTFILE=${custom}/elsewhere_history\nexport FROM_USER=rc\n`);
    const fromEnv = tempDataDir();
    writeFileSync(join(fromEnv, '.zshenv'), 'export FROM_USER=env\n');
    const withDotDir = tempDataDir();
    const dotDir = join(withDotDir, 'zdot');
    mkdirSync(dotDir);
    writeFileSync(join(dotDir, '.zshrc'), 'export FROM_USER=zdotdir\n');
    const homes: [string, Record<string, string>][] = [
      [plain, {}],
      [custom, {}],
      [fromEnv, {}],
      [withDotDir, { ZDOTDIR: dotDir }],
    ];
    for (const login of [false, true]) {
      for (const [home, user] of homes) {
        const ours = settings(home, true, login, user);
        expect(ours).toBe(settings(home, false, login, user));
        expect(ours).not.toContain('shell-integration');
      }
    }
  });
});

describe("a bash with the integration keeps the user's own settings", () => {
  it.runIf(existsSync('/bin/bash'))('has the same HISTFILE as a plain bash: only PROMPT_COMMAND is added', () => {
    const home = tempDataDir();
    writeFileSync(join(home, '.bashrc'), 'export FROM_USER=rc\n');
    const env = { HOME: home, PATH: process.env.PATH ?? '' };
    const read = (extra: Record<string, string>) =>
      execFileSync('/bin/bash', ['-i', '-c', 'echo "$HISTFILE|$FROM_USER"'], { env: { ...env, ...extra }, encoding: 'utf8', input: '' }).trim();
    expect(read(shellIntegrationEnv('/bin/bash', tempDataDir(), env))).toBe(read({}));
    expect(read({})).toBe(`${home}/.bash_history|rc`);
  });
});

describe('listening ports', () => {
  it('reads them from lsof -Fn, in order and once each', () => {
    expect(listeningPorts('p12\nf4\nn*:5173\nf5\nn[::1]:5173\nn127.0.0.1:3000\n')).toEqual([3000, 5173]);
    expect(listeningPorts('')).toEqual([]);
  });

});

describe('knowing an agent harness in the foreground', () => {
  const node = process.execPath;
  const setup = () => {
    const dir = tempDataDir();
    const script = join(dir, 'claude');
    writeFileSync(script, '#!/usr/bin/env node\nconsole.log(1);\n');
    chmodSync(script, 0o755);
    const native = join(dir, 'codex');
    copyFileSync('/bin/sleep', native);
    const pathOf = (harness: string) => ({ claude: script, codex: native })[harness];
    return { dir, script, native, pathOf };
  };

  it('by its executable, or the interpreter running its script by absolute path', () => {
    const { dir, script, native, pathOf } = setup();
    expect(harnessOfProgram({ exe: native, args: ['--resume'] }, pathOf)).toBe('codex');
    expect(harnessOfProgram({ exe: node, args: ['--disable-warning=ExperimentalWarning', script] }, pathOf)).toBe('claude');
    const link = join(dir, 'via-link');
    symlinkSync(script, link);
    expect(harnessOfProgram({ exe: node, args: [link] }, pathOf)).toBe('claude');
  });

  it('never by a name or a word in the command line', () => {
    const { script, native, pathOf } = setup();
    expect(harnessOfProgram({ exe: '/usr/bin/vim', args: [script] }, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: '/usr/bin/less', args: [native] }, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: '/usr/bin/python3', args: [script] }, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: '/usr/bin/vim', args: ['claude'] }, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: node, args: ['claude'] }, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: '/bin/sleep', args: ['30'] }, pathOf)).toBeNull();
    expect(harnessOfProgram(null, pathOf)).toBeNull();
    expect(harnessOfProgram({ exe: native, args: [] }, () => undefined)).toBeNull();
  });

  it('not for node told to run code, whatever script it names after; and a script path with spaces is matched', () => {
    const { script, pathOf } = setup();
    for (const flags of [['--eval=setTimeout(()=>{},9)'], ['-e', 'x'], ['--print', '1'], ['-p', '1'], ['-']]) {
      expect(harnessOfProgram({ exe: node, args: [...flags, script] }, pathOf)).toBeNull();
    }
    const spaced = join(tempDataDir(), 'My Tools', 'claude');
    mkdirSync(join(spaced, '..'), { recursive: true });
    copyFileSync(script, spaced);
    expect(harnessOfProgram({ exe: node, args: spaced.split(' ') }, (harness) => (harness === 'claude' ? spaced : undefined))).toBe('claude');
  });

  it('not for a copy of it, or another file of the same name', () => {
    const { script, native, pathOf } = setup();
    const copy = join(tempDataDir(), 'codex');
    copyFileSync(native, copy);
    expect(harnessOfProgram({ exe: copy, args: [] }, pathOf)).toBeNull();
    const imposter = join(tempDataDir(), 'claude');
    copyFileSync(script, imposter);
    expect(harnessOfProgram({ exe: node, args: [imposter] }, pathOf)).toBeNull();
  });
});
