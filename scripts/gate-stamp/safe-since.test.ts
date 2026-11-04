import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findReusableStamp, parseNumstat, safeSinceStamp, SAFE_MAX_CHANGED_LINES } from './safe-since.ts';
import { writeStamp } from './stamp.ts';

const change = (path: string, lines?: number | null) => ({ path, lines: lines === null ? undefined : (lines ?? 1) });

describe('safeSinceStamp', () => {
  it.each([
    'scripts/knip-worktree/main.ts',
    'scripts/release-public/verify-plan.ts',
    'apps/desktop/src/renderer/src/session/chat.ts',
    'knip.json',
    'eslint.config.js',
    'tsconfig.base.json',
    'vitest.shared.ts',
    'apps/desktop/vitest.config.ts',
  ])('allows a one-line change to %s', (path) => {
    expect(safeSinceStamp([change(path)]).safe).toBe(true);
  });

  it('allows the one-line renderer export fix that cost a release window', () => {
    expect(safeSinceStamp([change('apps/desktop/src/renderer/src/session/chat.ts', 2)])).toMatchObject({ safe: true });
  });

  it('allows a test or doc change of any size', () => {
    expect(safeSinceStamp([change('packages/core/src/a.test.ts', 400), change('docs/other/x.md', 90), change('apps/desktop/src/renderer/src/Tile.test.tsx', 300)]).safe).toBe(true);
  });

  it('does not count test and doc lines towards the cap of a mixed change', () => {
    expect(safeSinceStamp([change('scripts/a.ts', 1), change('scripts/a.test.ts', 25), change('README.md', 30)]).safe).toBe(true);
  });

  // The paths only the full gate (e2e, visual, daemon, packaging) or nothing in the quick checks covers. Keep this list
  // growing, not shrinking: it is what stops a release shipping an app that does not start.
  it.each([
    'apps/desktop/src/renderer/src/Tile.tsx',
    'apps/desktop/src/renderer/src/board.css',
    'release/public/README.md',
    'release/public/docs/faq.md',
    'apps/desktop/src/renderer/src/theme.ts',
    'apps/desktop/src/renderer/src/themes.ts',
    'apps/desktop/src/renderer/src/board-colors.ts',
    'apps/desktop/src/renderer/src/session/chat-style.ts',
    'apps/desktop/src/renderer/src/board/items/text-layout.ts',
    'apps/desktop/src/renderer/src/geometry.ts',
    'apps/desktop/src/renderer/src/board/items/tile-size.ts',
    'apps/desktop/src/renderer/src/status-look.ts',
    'apps/desktop/src/renderer/src/board/items/agent-note-look.ts',
    'apps/desktop/src/renderer/src/board/shapes/arrow.ts',
    'apps/desktop/src/renderer/src/design.ts',
    'apps/desktop/src/renderer/src/states.ts',
    'apps/desktop/src/renderer/src/session/details-width.ts',
    'packages/tracker/src/issues.ts',
    'apps/desktop/src/main/index.ts',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/shared/x.ts',
    'apps/desktop/playwright.config.ts',
    'apps/desktop/electron.vite.config.ts',
    'apps/desktop/electron-builder.yml',
    'apps/desktop/package.json',
    'apps/desktop/e2e/visual.spec.ts-snapshots/a-dark-visual-darwin.png',
    'apps/desktop/e2e/board.spec.ts',
    'apps/desktop/e2e/board-helpers.ts',
    'packages/fake-harness/src/index.ts',
    'packages/daemon/src/server.ts',
    'packages/daemon/src/server.test.ts',
    'fixtures/a/session.jsonl',
    'scripts/check-local.sh',
    'scripts/visual.sh',
    'scripts/e2e-headless.sh',
    'scripts/e2e-flaky/main.ts',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.gitmodules',
    'release/public.config.ts',
    'some/new/place.ts',
  ])('refuses %s, even as a one-line change', (path) => {
    const verdict = safeSinceStamp([change('scripts/a.ts'), change(path)]);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain(path);
  });

  it('allows up to the line limit in code and refuses one more', () => {
    expect(safeSinceStamp([change('scripts/a.ts', SAFE_MAX_CHANGED_LINES - 5), change('scripts/b.ts', 5)]).safe).toBe(true);
    const verdict = safeSinceStamp([change('scripts/a.ts', SAFE_MAX_CHANGED_LINES - 5), change('scripts/b.ts', 6)]);
    expect(verdict).toEqual({ safe: false, reason: `${SAFE_MAX_CHANGED_LINES + 1} changed lines outside tests and docs, more than ${SAFE_MAX_CHANGED_LINES}` });
  });

  it('refuses a binary code file, and allows no change at all', () => {
    expect(safeSinceStamp([change('scripts/logo.bin', null)]).safe).toBe(false);
    expect(safeSinceStamp([]).safe).toBe(true);
  });
});

describe('parseNumstat', () => {
  it('reads counts, binary files and renames', () => {
    const out = '1\t2\ta.ts\0-\t-\tb.bin\0' + '0\t0\t\0old.css\0new.css\0';
    expect(parseNumstat(out)).toEqual([
      { path: 'a.ts', lines: 3 },
      { path: 'b.bin', lines: undefined },
      { path: 'old.css', lines: 0 },
      { path: 'new.css', lines: 0 },
    ]);
  });
});

describe('findReusableStamp', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function repoWithStampedBase() {
    dir = mkdtempSync(join(tmpdir(), 'ab-safe-'));
    const repo = join(dir, 'repo');
    const stamps = join(dir, 'stamps');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
    const commit = (files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(repo, name, '..'), { recursive: true });
        writeFileSync(join(repo, name), text);
      }
      git('add', '-A');
      git('commit', '--quiet', '-m', 'x');
      return git('rev-parse', 'HEAD');
    };
    git('init', '--quiet');
    const base = commit({ 'scripts/a.ts': 'one\n', 'apps/desktop/e2e/a.spec.ts': 'x\n' });
    writeStamp(stamps, base, new Date('2026-11-03T08:00:00Z'));
    return { repo, stamps, base, commit };
  }

  it('reuses the stamp across a one-line test change (a dry run on such a branch)', () => {
    const { repo, stamps, base, commit } = repoWithStampedBase();
    const head = commit({ 'scripts/a.test.ts': 'a line\n' });
    const found = findReusableStamp(repo, head, stamps);
    expect(found?.ancestor).toBe(base);
    expect(found?.behind).toBe(1);
    expect(found?.verdict.safe).toBe(true);
  });

  it('judges the whole range, so a forbidden file in an earlier commit still counts', () => {
    const { repo, stamps, commit } = repoWithStampedBase();
    commit({ 'apps/desktop/e2e/a.spec.ts': 'y\n' });
    const head = commit({ 'scripts/a.ts': 'two\n' });
    const found = findReusableStamp(repo, head, stamps);
    expect(found?.behind).toBe(2);
    expect(found?.verdict.safe).toBe(false);
  });

  it('refuses a submodule bump however few lines numstat reports', () => {
    const { repo, stamps } = repoWithStampedBase();
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    const inner = join(dir as string, 'inner');
    mkdirSync(inner);
    execFileSync('git', ['-C', inner, 'init', '--quiet']);
    execFileSync('git', ['-C', inner, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'i']);
    const sha = execFileSync('git', ['-C', inner, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `160000,${sha},scripts/vendored`);
    git('commit', '--quiet', '-m', 'sub');
    const head = git('rev-parse', 'HEAD').trim();
    const found = findReusableStamp(repo, head, stamps);
    expect(found?.verdict).toEqual({ safe: false, reason: 'a submodule changed' });
  });

  it('walks past a stale stamp to an older fresh one', () => {
    const { repo, stamps, base, commit } = repoWithStampedBase();
    const middle = commit({ 'scripts/a.ts': 'two\n' });
    writeStamp(stamps, middle, new Date('2026-11-01T00:00:00Z'));
    const head = commit({ 'scripts/a.ts': 'three\n' });
    expect(findReusableStamp(repo, head, stamps, (at) => at.getUTCDate() === 3)?.ancestor).toBe(base);
  });

  it('finds nothing when no ancestor is stamped', () => {
    const { repo, commit } = repoWithStampedBase();
    const head = commit({ 'scripts/a.ts': 'two\n' });
    expect(findReusableStamp(repo, head, join(dir as string, 'none'))).toBeUndefined();
  });
});
