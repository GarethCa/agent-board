import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runEveryTeardown, shimGuardGlobalSetup } from '../src/index.ts';
import { removeTempDirs, tempDir } from './run-fake.ts';

afterAll(removeTempDirs);

/** A home whose `.agent-board/bin` holds the installed app's two launchers. */
function homeWithLaunchers(): { home: string; bin: string } {
  const home = tempDir('shim-guard-home-');
  const bin = join(home, '.agent-board', 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['agent-board', 'agent-board-hook']) writeFileSync(join(bin, name), 'exec /Applications/agent-board.app/x "$@"\n');
  return { home, bin };
}

describe('shim guard', () => {
  it('fails the run when a test points a live launcher at this checkout', () => {
    const { home, bin } = homeWithLaunchers();
    const teardown = shimGuardGlobalSetup('/work/checkout/', home);
    writeFileSync(join(bin, 'agent-board-hook'), 'exec /work/checkout/apps/desktop/node_modules/electron "$@"\n');
    expect(teardown).toThrow(/rewrote the live launcher .*agent-board-hook to run something under \/work\/checkout\//);
  });

  it('fails the run when a test writes a launcher that was not there', () => {
    const home = tempDir('shim-guard-home-');
    const teardown = shimGuardGlobalSetup('/work/checkout/', home);
    mkdirSync(join(home, '.agent-board', 'bin'), { recursive: true });
    writeFileSync(join(home, '.agent-board', 'bin', 'agent-board'), 'exec /work/checkout/x "$@"\n');
    expect(teardown).toThrow(/agent-board shim guard/);
  });

  it('lets the installed app rewrite its own launchers, and a launcher removed, through', () => {
    const { home, bin } = homeWithLaunchers();
    const teardown = shimGuardGlobalSetup('/work/checkout/', home);
    writeFileSync(join(bin, 'agent-board'), 'exec /Applications/agent-board.app/y "$@"\n');
    rmSync(join(bin, 'agent-board-hook'));
    expect(teardown).not.toThrow();
  });

  it('fails the run on a checkout path the shell quoting escaped', () => {
    const { home, bin } = homeWithLaunchers();
    const teardown = shimGuardGlobalSetup("/work/it's/", home);
    writeFileSync(join(bin, 'agent-board'), "exec '/work/it'\\''s/electron' \"$@\"\n");
    expect(teardown).toThrow(/agent-board shim guard/);
  });

  it('fails the run when a test points the live external-hook.json at this checkout', () => {
    const { home } = homeWithLaunchers();
    const teardown = shimGuardGlobalSetup('/work/checkout/', home);
    writeFileSync(join(home, '.agent-board', 'external-hook.json'), JSON.stringify({ socket: '/work/checkout/x.sock' }));
    expect(teardown).toThrow(/external-hook\.json/);
  });
});

describe('every teardown', () => {
  it('runs after one throws, and throws all their errors together', () => {
    const ran: string[] = [];
    const fail = (name: string) => () => {
      ran.push(name);
      throw new Error(`${name} hit`);
    };
    expect(() => runEveryTeardown([fail('shims'), () => ran.push('git'), fail('harness')])).toThrow(/shims hit\n\nharness hit/);
    expect(ran).toEqual(['shims', 'git', 'harness']);
    expect(() => runEveryTeardown([fail('one')])).toThrow(/^one hit$/);
  });
});
