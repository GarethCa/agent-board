import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_MAP, isServerSuite, SCANNERS, SERVER_SUITE_DIRS, SMOKE_SPECS, selectChecks } from './select.ts';
import { stepsFor } from './steps.ts';

/** The test that scans every script for a writer of green stamps; any script change selects it. */
const STAMP_GUARD = 'scripts/gate-stamp/stamp.test.ts';

describe('selectChecks', () => {
  it('runs only lint-level checks for a docs change', () => {
    const plan = selectChecks(['docs/BRIEF.md', 'CONTRIBUTING.md']);
    expect(plan).toMatchObject({ full: false, unit: [], e2e: [], visual: false });
  });

  it('runs related unit tests and visual, but no e2e, for a CSS-only change', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/app.css']);
    expect(plan.full).toBe(false);
    expect(plan.unit).toContain('apps/desktop/src/renderer/src/app.css');
    expect(plan.visual).toBe(true);
    expect(plan.e2e).toEqual([]);
  });

  it('maps a daemon file to its specs, with no visual run', () => {
    const plan = selectChecks(['packages/daemon/src/flow-edges.ts']);
    expect(plan.e2e).toEqual(['flow-edges.spec.ts']);
    expect(plan.visual).toBe(false);
    expect(plan.unit.slice(0, 2)).toEqual(['packages/daemon/src/flow-edges.ts', 'scripts/release-public/leak-rules.test.ts']);
  });

  it('maps renderer zone files to the zone specs', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/board/zone-nodes.ts']);
    expect(plan.e2e).toEqual(['add-zone.spec.ts', 'zone-fold.spec.ts', 'zoneless-agents.spec.ts', 'zones.spec.ts']);
  });

  it('runs the fold spec for the folded zone’s chip, its helpers and the daemon’s fold', () => {
    for (const file of ['apps/desktop/src/renderer/src/board/FoldedZone.tsx', 'apps/desktop/src/renderer/src/board/fold-zone.ts', 'apps/desktop/src/main/zones.ts', 'packages/daemon/src/zone-fold.ts']) {
      expect(selectChecks([file]).e2e).toContain('zone-fold.spec.ts');
    }
  });

  it('runs the smoke set for an unmapped, non-core app file', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/Gallery.tsx']);
    expect(plan.e2e).toEqual([...SMOKE_SPECS].sort());
    expect(plan.visual).toBe(true);
  });

  it('adds the smoke set to the mapped specs when one file is unmapped', () => {
    const plan = selectChecks(['packages/daemon/src/flow-edges.ts', 'apps/desktop/src/renderer/src/Gallery.tsx']);
    expect(plan.e2e).toEqual(expect.arrayContaining(['flow-edges.spec.ts', ...SMOKE_SPECS]));
  });

  it('runs a changed spec and nothing else of e2e', () => {
    const plan = selectChecks(['apps/desktop/e2e/rename.spec.ts']);
    expect(plan.e2e).toEqual(['rename.spec.ts']);
    expect(plan.unit).toEqual([]);
    expect(plan.visual).toBe(false);
  });

  it('runs visual when baselines or the visual spec change', () => {
    expect(selectChecks(['apps/desktop/e2e/visual.spec.ts-snapshots/board-visual-linux.png']).visual).toBe(true);
    for (const file of ['apps/desktop/e2e/visual/board.spec.ts', 'apps/desktop/e2e/visual/shared.ts']) {
      expect(selectChecks([file])).toMatchObject({ full: false, unit: [], e2e: [], visual: true });
    }
  });

  it('runs nothing for the on-request Linux visual tooling, but the stamp-writer guard for its script', () => {
    expect(selectChecks(['docker/visual-linux/Dockerfile'])).toMatchObject({ full: false, unit: [], e2e: [], visual: false });
    expect(selectChecks(['scripts/visual-linux.sh'])).toMatchObject({ full: false, unit: [STAMP_GUARD], e2e: [], visual: false });
  });

  it('always runs the release leak rules with the unit tests, since vitest related would never pick them', () => {
    expect(selectChecks(['apps/desktop/src/x.test.ts']).unit).toContain('scripts/release-public/leak-rules.test.ts');
    expect(selectChecks(['docs/BRIEF.md']).unit).toEqual([]);
    // A tree without the test pins nothing.
    expect(selectChecks(['apps/desktop/src/x.test.ts'], (file) => file !== 'scripts/release-public/leak-rules.test.ts').unit).not.toContain('scripts/release-public/leak-rules.test.ts');
  });

  it('does not run e2e for a unit test change', () => {
    const plan = selectChecks(['packages/daemon/src/cron.test.ts']);
    expect(plan.e2e).toEqual([]);
    expect(plan.unit.slice(0, 2)).toEqual(['packages/daemon/src/cron.test.ts', 'scripts/release-public/leak-rules.test.ts']);
  });

  it.each([
    'scripts/check-local.sh',
    'scripts/check-pr/main.ts',
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'knip.json',
    'apps/desktop/e2e/launch.ts',
    'apps/desktop/e2e/agent-helpers.ts',
    'packages/fake-harness/src/guard.ts',
    'packages/daemon/src/protocol.ts',
  ])('falls back to the full gate when %s changes', (file) => {
    const plan = selectChecks([file, 'apps/desktop/src/renderer/src/app.css']);
    expect(plan).toMatchObject({ full: true, unit: [], e2e: [], visual: false });
    expect(plan.reasons[0]).toContain(file);
  });

  it('does not run a deleted spec, nor one that is not in the app project', () => {
    const exists = (file: string): boolean => !file.endsWith('gone.spec.ts');
    const plan = selectChecks(['apps/desktop/e2e/gone.spec.ts', 'apps/desktop/e2e/visual/chat.spec.ts', 'apps/desktop/e2e/packaged.spec.ts'], exists);
    expect(plan.e2e).toEqual([]);
    expect(plan.visual).toBe(true);
    expect(plan.full).toBe(false);
  });

  it('does not run a benchmark spec in the app project, which ignores it and would find no tests', () => {
    for (const name of ['render-bench.spec.ts', 'agents-bench.spec.ts', 'pan-zoom-bench.spec.ts']) {
      const plan = selectChecks([`apps/desktop/e2e/${name}`], () => true);
      expect(plan.e2e).toEqual([]);
      expect(plan.reasons.join('\n')).toContain('runs in its own project');
    }
  });

  it('widens to the whole unit project and all e2e when the key registry changes, which every surface matches its keys through', () => {
    for (const file of ['apps/desktop/src/renderer/src/keys/registry.ts', 'apps/desktop/src/renderer/src/keys/index.ts']) {
      expect(selectChecks([file])).toMatchObject({ full: false, unitAll: true, e2eAll: true });
    }
  });

  describe('blast radius', () => {
    it.each([
      'apps/desktop/src/renderer/src/App.tsx',
      'apps/desktop/src/renderer/src/ui/Button.tsx',
      'apps/desktop/src/renderer/src/chrome/Header.tsx',
      'apps/desktop/src/renderer/src/keys/registry.ts',
      'apps/desktop/src/renderer/src/board/TileNode.tsx',
      'apps/desktop/src/shared/themes.ts',
      'apps/desktop/src/preload/index.ts',
      'apps/desktop/src/main/index.ts',
    ])('runs the whole unit project, all e2e and visual, not the full gate, for desktop core %s', (file) => {
      const plan = selectChecks([file]);
      expect(plan.full).toBe(false);
      expect(plan.unitAll).toBe(true);
      expect(plan.e2eAll).toBe(true);
      expect(plan.e2e).toEqual([]);
      expect(plan.reasons.join('\n')).toContain('desktop core');
    });

    it('runs visual for a renderer core change, and not for a main-process core change', () => {
      expect(selectChecks(['apps/desktop/src/renderer/src/ui/Button.tsx']).visual).toBe(true);
      expect(selectChecks(['apps/desktop/src/shared/themes.ts']).visual).toBe(true);
      expect(selectChecks(['apps/desktop/src/main/view.ts']).visual).toBe(false);
    });

    it('never runs the whole processes project, nor the full gate, for a desktop-only change', () => {
      const plan = selectChecks([
        'apps/desktop/src/renderer/src/board/TileNode.tsx',
        'apps/desktop/src/renderer/src/session/Foo.tsx',
        'apps/desktop/src/main/zones.ts',
        'docs/x.md',
      ]);
      expect(plan).toMatchObject({ full: false, unitAll: true, e2eAll: true });
      const steps = stepsFor(plan, { leakCheck: false, exists: () => true, headless: false });
      const commands = steps.map((step) => step.argv.join(' '));
      expect(commands.some((command) => command.includes('check-local'))).toBe(false);
      expect(commands.filter((command) => /--project processes/.test(command) && !/vitest related/.test(command))).toEqual([]);
      expect(commands).toContain('pnpm exec vitest run --project unit');
      expect(steps.some((step) => step.name === 'processes')).toBe(false);
    });

    it.each([
      ['packages/daemon/src/import-meta-glob.test.ts', false],
      ['scripts/release-public/leak-rules.test.ts', false],
      ['apps/desktop/src/renderer/src/ui/Button.tsx', false],
      ['packages/daemon/test/agents.test.ts', true],
      ['scripts/release-public/public-config.test.ts', true],
      ['packages/daemon/src/schedules.ts', true],
    ])('%s reaches the processes project: %s', (file, reaches) => {
      const plan = selectChecks(['apps/desktop/src/renderer/src/ui/Button.tsx', file]);
      expect(plan.processes?.includes(file) ?? false).toBe(reaches);
    });

    it('says in the unit reason how many files the processes step gets', () => {
      const plan = selectChecks(['apps/desktop/src/shared/themes.ts', 'packages/daemon/src/import-meta-glob.test.ts']);
      expect(plan.processes).toEqual([]);
      expect(plan.reasons.find((reason) => reason.startsWith('unit: '))).toContain('nothing else');
    });

    it('runs the perf project with the board and shell core, and not otherwise', () => {
      expect(selectChecks(['apps/desktop/src/renderer/src/board/TileNode.tsx']).perf).toBe(true);
      expect(selectChecks(['apps/desktop/src/renderer/src/App.tsx']).perf).toBe(true);
      expect(selectChecks(['apps/desktop/src/renderer/src/ui/Button.tsx']).perf).toBeFalsy();
      expect(selectChecks(['apps/desktop/src/shared/themes.ts']).perf).toBeFalsy();
    });

    it('does not widen for a test file in a core directory', () => {
      const plan = selectChecks(['apps/desktop/src/renderer/src/keys/registry.test.ts']);
      expect(plan.unitAll).toBeFalsy();
      expect(plan.e2eAll).toBeFalsy();
      expect(plan.visual).toBe(false);
    });

    it('keeps the reasons consistent with the widened plan', () => {
      const reasons = selectChecks(['apps/desktop/src/shared/themes.ts']).reasons;
      expect(reasons.filter((reason) => reason.startsWith('visual: '))).toEqual(['visual: a renderer, shared or preload core file changed']);
      expect(reasons.filter((reason) => reason.startsWith('unit: '))).toHaveLength(1);
      expect(reasons.find((reason) => reason.startsWith('unit: '))).toContain('whole unit project');
    });

    it('leaves a non-core desktop change on related tests and mapped specs', () => {
      const plan = selectChecks(['apps/desktop/src/renderer/src/board/zones.ts']);
      expect(plan.unitAll).toBeFalsy();
      expect(plan.e2eAll).toBeFalsy();
    });

    it.each([
      'packages/daemon/src/migrations/001.sql',
      'packages/fake-harness/src/claude.ts',
    ])('keeps the full gate for daemon-side core %s', (file) => {
      expect(selectChecks([file]).full).toBe(true);
    });

    it('keeps the full gate when a desktop core change comes with a gate or daemon-core file', () => {
      expect(selectChecks(['apps/desktop/src/shared/themes.ts', 'package.json']).full).toBe(true);
      expect(selectChecks(['apps/desktop/src/preload/index.ts', 'packages/daemon/src/rpc.ts']).full).toBe(true);
    });
  });

  it('runs the full gate when the perf spec changes', () => {
    expect(selectChecks(['apps/desktop/e2e/board-perf.spec.ts']).full).toBe(true);
  });

  it.each([
    'apps/desktop/e2e/newhelper.ts',
    'scripts/visual.sh',
    'apps/desktop/electron-builder.yml',
    '.github/workflows/ci.yml',
    '.nvmrc',
    'some/unknown/thing.bin',
  ])('runs the full gate for the unrecognised or gate-adjacent file %s', (file) => {
    expect(selectChecks([file]).full).toBe(true);
  });

  it('runs the full gate for the migration runner, as for the migrations', () => {
    expect(selectChecks(['packages/daemon/src/migrate.ts']).full).toBe(true);
  });

  it('maps the daemon zone and tracker modules to their specs', () => {
    expect(selectChecks(['packages/daemon/src/zones.ts']).e2e).toEqual(['add-zone.spec.ts', 'zoneless-agents.spec.ts', 'zones.spec.ts']);
    expect(selectChecks(['packages/daemon/src/trackers.ts']).e2e).toEqual(['trackers.spec.ts']);
  });

  it('maps the PR tab, its IPC, its daemon methods and its GitHub calls to the PR tab spec', () => {
    for (const file of [
      'apps/desktop/src/renderer/src/session/PullRequestTab.tsx',
      'apps/desktop/src/renderer/src/session/use-pull-request.ts',
      'apps/desktop/src/renderer/src/session/pr-diff.ts',
      'apps/desktop/src/main/pull-requests.ts',
      'packages/daemon/src/pull-request-tabs.ts',
      'packages/tracker/src/pull-request-details.ts',
      'packages/tracker/src/pull-request-ref.ts',
      'packages/tracker/src/fake-gh.ts',
    ]) {
      expect(selectChecks([file]).e2e, file).toContain('pr-tab.spec.ts');
    }
  });

  it('maps the chat view and the transcript adapters to the chat view spec', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/session/ChatView.tsx']).e2e).toContain('chat-view.spec.ts');
    expect(selectChecks(['packages/daemon/src/transcript-adapters.ts']).e2e).toEqual(['chat-view.spec.ts']);
    expect(selectChecks(['packages/daemon/src/transcripts.ts']).e2e).toEqual(['chat-view.spec.ts']);
  });

  it('maps the session body, which wires up the terminal keys, to the terminal newline spec', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/session/SessionBody.tsx']).e2e).toContain('terminal-newline.spec.ts');
  });

  it('runs visual for renderer code that moves things, not just styles', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/board/perch.ts']).visual).toBe(true);
  });

  it('runs no checks beyond the cheap ones for docs, prompts and tooling with their own tests', () => {
    const plan = selectChecks([
      'docs/BRIEF.md',
      '.claude/agent-prompts/impl-prompt.md',
      'scripts/try-latest/try-latest.ts',
      'scripts/release-public/sanitise.ts',
      'release/public.config.ts',
      'README.md',
    ]);
    expect(plan.full).toBe(false);
    expect(plan.e2e).toEqual([]);
    expect(plan.visual).toBe(false);
  });

  it('only names specs that exist', async () => {
    const { readdirSync } = await import('node:fs');
    const existing = new Set(readdirSync(new URL('../../apps/desktop/e2e/', import.meta.url)));
    for (const spec of [...SMOKE_SPECS, ...E2E_MAP.flatMap(([, specs]) => specs)]) expect(existing, spec).toContain(spec);
  });
});

describe('the server suite', () => {
  /** A daemon file that no spec maps to and that is not daemon core. */
  const DAEMON_FILE = 'packages/daemon/src/event-ring.ts';
  const runs = (plan: ReturnType<typeof selectChecks>) => stepsFor(plan, { leakCheck: false, exists: () => true, headless: false }).map((step) => step.name);

  it('runs the suite and unit tests for a change to a daemon file no spec maps to, with no e2e and no visual', () => {
    const plan = selectChecks([DAEMON_FILE]);
    expect(plan).toMatchObject({ full: false, server: true, e2e: [], visual: false });
    expect(plan.unit).toEqual(expect.arrayContaining([DAEMON_FILE]));
    expect(runs(plan)).toEqual(expect.arrayContaining(['unit', 'server']));
    expect(runs(plan)).not.toEqual(expect.arrayContaining(['build']));
    expect(runs(plan).filter((name) => ['e2e', 'visual'].includes(name))).toEqual([]);
    expect(plan.reasons.join('\n')).toContain('the server suite covers it');
  });

  it.each([
    'packages/daemon/src/protocol.ts',
    'packages/daemon/src/rpc.ts',
    'packages/daemon/src/items.ts',
    'packages/daemon/src/sessions.ts',
    'packages/daemon/src/board-layout.ts',
    'packages/daemon/src/agent-spawns.ts',
    'packages/daemon/src/deliveries.ts',
    'packages/daemon/src/counts.ts',
  ])('runs the suite in place of the full gate or the smoke set for the daemon file %s alone', (file) => {
    const plan = selectChecks([file]);
    expect(plan).toMatchObject({ full: false, server: true, visual: false });
    expect(plan.e2e.filter((spec) => SMOKE_SPECS.includes(spec))).toEqual([]);
  });

  it('keeps the specs a daemon file maps to, beside the suite', () => {
    expect(selectChecks(['packages/daemon/src/flow-edges.ts'])).toMatchObject({ server: true, e2e: ['flow-edges.spec.ts'] });
  });

  it('runs the suite for its own tests and helpers', () => {
    for (const file of ['packages/daemon/test/server/send.test.ts', 'packages/daemon/test/server/viewers.test.ts']) {
      expect(selectChecks([file]), file).toMatchObject({ full: false, server: true, e2e: [] });
    }
  });

  it('keeps the full gate for a file under the daemon\'s src that is no source it knows', () => {
    for (const file of ['packages/daemon/src/hooks/notify.sh', 'packages/daemon/src/agent.plist', 'packages/daemon/src/page.js']) {
      expect(selectChecks([file]).full, file).toBe(true);
    }
  });

  it('covers every test the server project in vitest.config.ts runs', async () => {
    const { default: root } = await import('../../vitest.config.ts');
    const projects = (root.test?.projects ?? []) as { test: { name: string; include: string[] } }[];
    const include = projects.find((project) => project.test.name === 'server')!.test.include;
    expect(include.length).toBeGreaterThan(0);
    for (const glob of include) {
      const file = glob.replace('**/*.test.ts', 'a/b.test.ts');
      expect(isServerSuite(file), glob).toBe(true);
      expect(SERVER_SUITE_DIRS.some((dir) => glob.startsWith(dir.replace('**', ''))), glob).toBe(true);
    }
  });

  it('leaves the suite out of a change that touches no daemon file, and of a daemon unit test kept beside its module', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/board/zones.ts']).server).toBeFalsy();
    expect(selectChecks(['packages/daemon/src/terminal-sizing.test.ts']).server).toBeFalsy();
    expect(selectChecks(['packages/daemon/src/README.md']).server).toBeFalsy();
  });

  it('still runs e2e when desktop files change with daemon files', () => {
    const plan = selectChecks([DAEMON_FILE, 'apps/desktop/src/renderer/src/Gallery.tsx']);
    expect(plan.server).toBe(true);
    expect(plan.e2e).toEqual([...SMOKE_SPECS].sort());
    expect(runs(plan)).toEqual(expect.arrayContaining(['server', 'e2e', 'visual']));
  });

  it('runs the full gate for the protocol or a daemon core file changed with a desktop file', () => {
    for (const daemon of ['packages/daemon/src/protocol.ts', 'packages/daemon/src/sessions.ts']) {
      const plan = selectChecks([daemon, 'apps/desktop/src/main/zones.ts']);
      expect(plan.full, daemon).toBe(true);
      expect(plan.reasons[0]).toContain(daemon);
    }
    // A desktop doc is no desktop change.
    expect(selectChecks(['packages/daemon/src/protocol.ts', 'apps/desktop/CLAUDE.md']).full).toBe(false);
  });

  it('runs the suite on its own, and leaves its project out of the related run', () => {
    const steps = stepsFor(selectChecks([DAEMON_FILE]), { leakCheck: false, exists: () => true, headless: false });
    expect(steps.find((step) => step.name === 'server')!.argv).toEqual(['pnpm', 'exec', 'vitest', 'run', '--project', 'server']);
    expect(steps.find((step) => step.name === 'unit')!.argv).toEqual(expect.arrayContaining(['related', '--project', 'unit', '--project', 'processes']));
    // A plain related run, with no suite, keeps every project.
    expect(stepsFor(selectChecks(['apps/desktop/src/renderer/src/board/zones.ts']), { leakCheck: false, exists: () => true, headless: false }).find((step) => step.name === 'unit')!.argv).not.toContain('--project');
  });

  it('runs it in --quick too, which runs the unit tests a plan selects', () => {
    const steps = stepsFor(selectChecks([DAEMON_FILE]), { leakCheck: false, exists: () => true, headless: false, quick: true });
    expect(steps.map((step) => step.name)).toContain('server');
  });

  it('needs no server step when every unit test runs', () => {
    const plan = { ...selectChecks([DAEMON_FILE]), testAll: true };
    expect(runs(plan)).not.toContain('server');
  });
});

describe('the scanner list', () => {
  const LEAK = 'scripts/release-public/leak-rules.test.ts';
  const CSS_TESTS = [
    'apps/desktop/src/renderer/src/chrome/drag-regions.test.ts',
    'apps/desktop/src/renderer/src/demo/demo-mode.test.ts',
    'apps/desktop/src/renderer/src/swatch-folding.test.ts',
    'apps/desktop/src/renderer/src/tokens.test.ts',
  ];

  it('runs the stylesheet scanners for a CSS change, which no import reaches', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/app.css']);
    expect(plan.unit).toEqual(expect.arrayContaining(CSS_TESTS));
    expect(plan.reasons.join('\n')).toContain('tokens.test.ts');
  });

  it('runs the stylesheet scanners for renderer markup too, which carries the class names and colours', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/board/perch.ts']).unit).toEqual(expect.arrayContaining(CSS_TESTS));
  });

  it('leaves the stylesheet scanners out of a daemon-only change', () => {
    const unit = selectChecks(['packages/daemon/src/flow-edges.ts']).unit;
    for (const test of CSS_TESTS) expect(unit).not.toContain(test);
  });

  it('runs the release rules test for release files and the files a rule names', () => {
    const rules = 'scripts/release-public/public-config.test.ts';
    expect(selectChecks(['release/public/README.md']).unit).toContain(rules);
    expect(selectChecks(['release/public.config.ts']).unit).toContain(rules);
    expect(selectChecks(['packages/daemon/src/repo-zone.ts']).unit).not.toContain(rules);
    expect(selectChecks(['packages/daemon/src/repo-zone.ts'], () => true, ['packages/daemon/src/repo-zone.ts']).unit).toContain(rules);
    expect(selectChecks(['docs/BRIEF.md'], () => true, ['docs/BRIEF.md']).unit).toContain(rules);
  });

  it('runs the always-run tests for any code change, and nothing for docs', () => {
    expect(selectChecks(['packages/daemon/src/flow-edges.ts']).unit).toContain(LEAK);
    expect(selectChecks(['docs/BRIEF.md']).unit).toEqual([]);
  });

  it('skips a scanner whose test is not in the tree', () => {
    const unit = selectChecks(['apps/desktop/src/renderer/src/app.css'], (file) => !file.endsWith('tokens.test.ts')).unit;
    expect(unit).not.toContain('apps/desktop/src/renderer/src/tokens.test.ts');
    expect(unit).toContain('apps/desktop/src/renderer/src/swatch-folding.test.ts');
  });

  it('lists no test twice', () => {
    const tests = SCANNERS.flatMap((scanner) => scanner.tests);
    expect(new Set(tests).size).toBe(tests.length);
  });

  it('names a test file that exists for every entry', () => {
    const tracked = new Set(git('ls-files', '-z'));
    for (const { tests } of SCANNERS) for (const test of tests) if (!ABSENT_WITH_RELEASE_TOOLING(test)) expect(tracked, test).toContain(test);
  });

  // `vitest related` follows imports, so a test that finds its inputs by reading the repo is never selected. A new one
  // must go in SCANNERS with the files it reads, or the gate stops catching what it catches today.
  it('lists every test that scans the repo', () => {
    const listed = new Set(SCANNERS.flatMap((scanner) => scanner.tests).filter((test) => !ABSENT_WITH_RELEASE_TOOLING(test)));
    const scanning = git('ls-files', '-z')
      .filter((file) => /\.test\.tsx?$/.test(file) && file !== 'scripts/check-pr/select.test.ts' && !(file in WORKS_ON_TEMP_COPIES))
      .filter((file) => scansTheRepo(readFileSync(join(REPO, file), 'utf8')));
    expect(scanning.filter((file) => !listed.has(file))).toEqual([]);
    // The check can see the tests it is meant to see.
    expect(scanning).toEqual(expect.arrayContaining([...listed]));
  });
});

/** Tests the check below flags that need no entry: they read a temp dir or clone they made, or what they read already runs the full gate. */
const WORKS_ON_TEMP_COPIES: Record<string, string> = {
  'packages/daemon/test/migrate.test.ts': 'reads the migrations, a full gate',
  'scripts/deadline/check-local.test.ts': 'runs scripts/check-local.sh, a full gate',
  'scripts/knip-worktree/knip-worktree.test.ts': 'reads the file list for the knip wrapper, a gate file',
  'packages/daemon/test/images-and-links.test.ts': 'lists the daemon data dir it made',
  'scripts/gate-stamp/check-local.test.ts': 'runs scripts/check-local.sh, a full gate',
  'scripts/release-public/release.test.ts': 'lists the clone it made',
};
const REPO = join(import.meta.dirname, '../..');
/** A checkout without release/ may lack some of its tests too; selectChecks skips a missing test. */
const ABSENT_WITH_RELEASE_TOOLING = (test: string): boolean => !existsSync(join(REPO, 'release')) && !existsSync(join(REPO, test));
const git = (...args: string[]): string[] => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
/** Lists the tracked files, or walks the source tree from the test's own place, reads a stylesheet (by name, or into postcss), or runs a shell script by a path from its own place. */
const scansTheRepo = (source: string): boolean =>
  /['"]ls-files['"]/.test(source) || (/readdirSync\(/.test(source) && /import\.meta\.(dirname|url)/.test(source)) || /readFileSync\([^\n]*\.css['"`)]/.test(source) || /postcss\.parse\(readFileSync/.test(source) || /import\.meta\.dirname[^\n]*\.sh['"`)]/.test(source);
