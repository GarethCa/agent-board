/**
 * Which checks a PR needs, from the files it changes. Pure: `main.ts` feeds it `git diff` and runs the plan.
 *
 * The rules, in order:
 *  1. A change to the gate itself, the shared config, the e2e helpers, the fake CLIs, the daemon protocol, a heavily shared
 *     daemon module (`DAEMON_CORE_GLOBS`) or any file nothing here recognises can break anything, so the plan is the full gate
 *     (`pnpm check:local`). Unknown means full: the fallback never runs less than it should.
 *  2. Unit tests: `vitest related` on the changed files, plus the scanners (`SCANNERS`): tests that read the repo's files
 *     rather than import them, which `related` never selects.
 *  3. E2E: the specs the change maps to (`E2E_MAP`), plus any changed spec that still exists and runs in the `app` project. A changed app file that maps to nothing runs
 *     the smoke set. Tests, docs and scripts alone run no e2e.
 *     Desktop core (`DESKTOP_CORE_GLOBS`) runs the whole `unit` project and every spec instead.
 *  4. Visual: when anything under the renderer (styles, markup, layout code) or the baselines changed.
 */
import { matchesGlob } from 'node:path';

/**
 * A test that finds its inputs by reading the repo (`git ls-files`, a walk of the source tree, a stylesheet) is in no
 * import graph, so `vitest related` never picks it. Each one is listed with the files it reads; `select.test.ts` fails
 * when a test that scans the repo is missing. `globs` is `'always'` for a test that reads every file, run with any code change.
 * `release` stands for the files the release rules name outright (`releaseRulePaths`). Rules that name files by a glob, or
 * none, are not tracked per PR: only the full gate and the batch runs catch a stale one.
 */
export const SCANNERS: ReadonlyArray<{ tests: readonly string[]; globs: readonly string[] | 'always' | 'release'; why: string }> = [
  {
    tests: [
      'apps/desktop/src/renderer/src/tokens.test.ts',
      'apps/desktop/src/renderer/src/swatch-folding.test.ts',
      'apps/desktop/src/renderer/src/chrome/drag-regions.test.ts',
      'apps/desktop/src/renderer/src/demo/demo-mode.test.ts',
      'apps/desktop/src/renderer/src/board/board-background.test.ts',
    ],
    // The `shared/` theme sources are a full gate today (`FULL_GATE_GLOBS`); the glob takes effect when that narrows.
    globs: ['apps/desktop/src/renderer/**/*.{css,ts,tsx}', 'apps/desktop/src/shared/{themes,theme-pack-tokens,design,colour}.ts'],
    why: 'stylesheets and theme sources',
  },
  { tests: ['scripts/release-public/public-config.test.ts'], globs: 'release', why: 'release rules and the files they name' },
  { tests: ['scripts/release-public/leak-rules.test.ts'], globs: 'always', why: 'the release leak rules' },
  { tests: ['packages/daemon/src/import-meta-glob.test.ts'], globs: ['{apps,packages}/*/src/**/*.{ts,tsx}'], why: 'source files' },
  { tests: ['scripts/worker-hooks/status-hook.test.ts'], globs: ['.claude/worker-hooks/**'], why: 'the worker status hook it runs' },
  { tests: ['scripts/gate-stamp/stamp.test.ts'], globs: ['scripts/**/*.{ts,sh}'], why: 'the scripts it scans for a writer of green stamps' },
];

/** Files whose change falls back to the full gate. */
const FULL_GATE_GLOBS = [
  'scripts/check-*',
  'scripts/e2e-headless.sh',
  'scripts/check-pr/**',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '**/package.json',
  'tsconfig*.json',
  '**/tsconfig*.json',
  'vitest.config.*',
  'eslint.config.*',
  '.markdownlint*',
  'knip.json',
  'apps/desktop/playwright.config.ts',
  'apps/desktop/electron.vite.config.ts',
  // Every e2e file that is not a spec is a helper, a new one included; the perf spec has no other gate.
  'apps/desktop/e2e/*.ts',
  'apps/desktop/electron-builder.yml',
  '.github/workflows/**',
  '.nvmrc',
  '.node-version',
  'apps/desktop/e2e/fonts/**',
  'apps/desktop/e2e/images/**',
  'packages/fake-harness/**',
  'packages/daemon/src/protocol.ts',
  'packages/daemon/src/migrations/**',
  'packages/daemon/src/migrate.ts',
];

/**
 * Desktop modules nearly every journey goes through: a change here can break any spec, so it runs the whole `unit` project
 * and every app e2e spec rather than the mapped ones or the smoke set. CSS is not in this list; a style change is covered by
 * the visual tests.
 */
const DESKTOP_CORE_GLOBS = [
  // What the main and renderer processes both import, and the bridge between them.
  'apps/desktop/src/shared/**',
  'apps/desktop/src/preload/**',
  'apps/desktop/src/renderer/src/{App,main}.tsx',
  'apps/desktop/src/renderer/src/{harness,states,errors,use-action}.ts',
  // The key registry: every handler on every surface matches its keys through it.
  'apps/desktop/src/renderer/src/keys/**/*.{ts,tsx}',
  'apps/desktop/src/renderer/src/ui/**/*.{ts,tsx}',
  'apps/desktop/src/renderer/src/chrome/**/*.{ts,tsx}',
  'apps/desktop/src/renderer/src/board/{Board,commands,representations,TileNode,HybridTile}.tsx',
  'apps/desktop/src/renderer/src/board/{tile,tiles}.ts',
  'apps/desktop/src/main/{index,items,view,setup}.ts',
];

/** Daemon-side modules nearly every journey goes through. Nothing under `apps/desktop` can reach the daemon's tests, but these can break the desktop's, so they keep the full gate. */
const DAEMON_CORE_GLOBS = [
  'packages/daemon/src/{rpc,params,index,daemon,sessions,agents,agent-spawns,agent-lifecycle,hook-states,deliveries,items,view-state,spawn,stop,permissions,subagents,worktrees,client,board-layout}.ts',
  'packages/daemon/src/{harness-state,claude-state,codex-state,terminal-backend,terminal-input}.ts',
];

/** Files that need no check beyond lint, typecheck, the Markdown lint and knip: docs, notes, the worker prompts and tooling with its own unit tests. */
const NO_CHECK_GLOBS = [
  'docs/**',
  '**/*.md',
  'LICENSE',
  '.agent-board/**',
  '.claude/**',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/**',
  '.gitignore',
  'scripts/try-latest/**',
  'scripts/try-latest.sh',
  'scripts/release-public/**',
  'release/**',
  'scripts/worker-hooks/**',
  'scripts/codex-capture/**',
  'scripts/readme-screenshots.sh',
  // The Linux visual tooling is on-request, outside the gate; it and its baselines run nothing beyond the native `visual` step.
  'scripts/visual-linux.sh',
  'docker/**',
  // The board recordings run on request, in a Playwright project of their own that no gate step runs.
  'apps/desktop/e2e/capture/**',
  'scripts/promo-capture.sh',
];

/** Run when an app file changes and no `E2E_MAP` entry claims it: the acceptance journey and a few core specs. */
export const SMOKE_SPECS = ['acceptance.spec.ts', 'app.spec.ts', 'tiles.spec.ts', 'session.spec.ts'];

/** Source globs to the specs that cover them. Every glob that matches a file adds its specs. */
export const E2E_MAP: ReadonlyArray<readonly [glob: string, specs: readonly string[]]> = [
  ['apps/desktop/src/renderer/src/session/terminal-{gpu,sharpness}*', ['gpu-terminals.spec.ts', 'expanded-tile.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*zone*', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Zone*', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*flow-edge*', ['flow-edges.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*FlowEdge*', ['flow-edges.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*rename*', ['rename.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*schedule*', ['schedules.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Schedule*', ['schedules.spec.ts']],
  ['apps/desktop/src/renderer/src/board/items/**', ['stickies.spec.ts', 'text-shapes.spec.ts', 'images-and-links.spec.ts']],
  ['apps/desktop/src/renderer/src/board/items/{AgentNoteNode.tsx,TetherEdge.tsx,agent-note*}', ['agent-notes.spec.ts']],
  ['apps/desktop/src/renderer/src/board/items/{AgentNoteNode.tsx,agent-note*}', ['ask-claude.spec.ts']],
  ['apps/desktop/src/renderer/src/board/ask/**', ['ask-claude.spec.ts']],
  ['apps/desktop/src/renderer/src/board/editing/{SelectionOverlays.tsx,context-menu.tsx}', ['ask-claude.spec.ts', 'selection.spec.ts']],
  ['packages/daemon/src/{selection-asks,agent-notes}.ts', ['ask-claude.spec.ts']],
  ['apps/desktop/src/renderer/src/board/connectors/**', ['connectors.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Tile*', ['tiles.spec.ts', 'expanded-tile.spec.ts', 'tile-resize.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*tile*', ['tiles.spec.ts', 'expanded-tile.spec.ts', 'tile-resize.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*xpanded*', ['expanded-tile.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Agent*', ['agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Issue*', ['trackers.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*racker*', ['trackers.spec.ts']],
  ['apps/desktop/src/renderer/src/board/editing/**', ['selection.spec.ts', 'stickies.spec.ts']],
  ['apps/desktop/src/renderer/src/inbox/**', ['inbox.spec.ts']],
  ['apps/desktop/src/renderer/src/master/**', ['master-panel.spec.ts', 'board-master.spec.ts', 'master-restart.spec.ts']],
  ['apps/desktop/src/renderer/src/onboarding/**', ['onboarding.spec.ts']],
  ['apps/desktop/src/renderer/src/review/**', ['reviews.spec.ts']],
  ['apps/desktop/src/renderer/src/session/Shell*', ['shell-panes.spec.ts']],
  ['apps/desktop/src/renderer/src/board/ShellsChip.tsx', ['agent-tabs.spec.ts']],
  ['apps/desktop/src/renderer/src/session/{SessionBody.tsx,TerminalPane.tsx,newline-keys.ts}', ['terminal-newline.spec.ts']],
  ['apps/desktop/src/renderer/src/session/**', ['session.spec.ts', 'session-window.spec.ts', 'shell-panes.spec.ts', 'chat-view.spec.ts', 'agent-tabs.spec.ts', 'shell-tile-tabs.spec.ts', 'tab-moves.spec.ts', 'popout-moves.spec.ts']],
  ['apps/desktop/src/renderer/src/windows/**', ['session-window.spec.ts', 'popout-moves.spec.ts']],
  ['apps/desktop/src/main/zones.ts', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['apps/desktop/src/main/flow-edges.ts', ['flow-edges.spec.ts']],
  ['apps/desktop/src/main/reviews.ts', ['reviews.spec.ts']],
  ['apps/desktop/src/main/shells.ts', ['shell-panes.spec.ts', 'agent-tabs.spec.ts', 'shell-tile-tabs.spec.ts', 'tab-moves.spec.ts']],
  ['apps/desktop/src/main/trackers.ts', ['trackers.spec.ts']],
  ['apps/desktop/src/main/connectors.ts', ['connectors.spec.ts']],
  ['apps/desktop/src/main/notifications.ts', ['notifications.spec.ts']],
  ['apps/desktop/src/main/external.ts', ['external.spec.ts']],
  ['apps/desktop/src/main/{agents,sessions}.ts', ['agents.spec.ts', 'session.spec.ts']],
  ['apps/desktop/src/main/agents.ts', ['chat-view.spec.ts']],
  ['apps/desktop/src/main/{windows,chrome}.ts', ['session-window.spec.ts']],
  ['apps/desktop/src/main/{windows,tab-drags,web-tabs}.ts', ['popout-moves.spec.ts']],
  ['apps/desktop/src/main/appearance.ts', ['appearance.spec.ts']],
  ['apps/desktop/src/renderer/src/themes.ts', ['appearance.spec.ts']],
  ['apps/desktop/src/main/{daemon,background}.ts', ['daemon.spec.ts', 'daemon-reaping.spec.ts', 'reboot.spec.ts', 'app.spec.ts', 'notifications.spec.ts']],
  ['packages/daemon/src/flow-edges.ts', ['flow-edges.spec.ts']],
  ['packages/daemon/src/reviews.ts', ['reviews.spec.ts']],
  ['packages/daemon/src/review-doc.ts', ['reviews.spec.ts']],
  ['packages/daemon/src/{shells,pane-layout,node-pty-backend}.ts', ['shell-panes.spec.ts']],
  ['packages/daemon/src/{shells,window-layout}.ts', ['popout-moves.spec.ts']],
  ['packages/daemon/src/{schedules,cron}.ts', ['schedules.spec.ts']],
  ['packages/daemon/src/{image-store,image-sweeper,link-*,safe-fetch}.ts', ['images-and-links.spec.ts']],
  ['packages/daemon/src/{external-*,hook-*}.ts', ['external.spec.ts']],
  ['packages/daemon/src/connectors.ts', ['connectors.spec.ts']],
  ['packages/daemon/src/{board,board-*,cli,cli-*}.ts', ['board-cli.spec.ts']],
  ['apps/desktop/src/renderer/src/chrome/CliInstallSetting.tsx', ['board-cli.spec.ts']],
  ['apps/desktop/src/renderer/src/{chrome/*potlight*,board/tile-attention.ts,board/commands.tsx}', ['spotlight.spec.ts']],
  ['apps/desktop/src/main/setup.ts', ['onboarding.spec.ts', 'board-cli.spec.ts']],
  ['packages/daemon/src/{repo-zone,git,pull-requests}.ts', ['zones.spec.ts', 'zoneless-agents.spec.ts']],
  ['packages/daemon/src/{daemon,lock,pid,cli,paths}.ts', ['daemon.spec.ts', 'daemon-reaping.spec.ts', 'reboot.spec.ts']],
  ['packages/daemon/src/{zones,zone-sources,tile-position}.ts', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['packages/daemon/src/trackers.ts', ['trackers.spec.ts']],
  ['packages/daemon/src/{transcripts,transcript-adapters}.ts', ['chat-view.spec.ts']],
  ['packages/tracker/**', ['trackers.spec.ts']],
  // The PR tab, from the GitHub calls and the fake gh to the tab.
  ['apps/desktop/src/renderer/src/session/{PullRequestTab.tsx,use-pull-request.ts,pr-diff.ts}', ['pr-tab.spec.ts']],
  ['apps/desktop/src/main/pull-requests.ts', ['pr-tab.spec.ts']],
  ['packages/daemon/src/pull-request-tabs.ts', ['pr-tab.spec.ts']],
  ['packages/tracker/src/{pull-request-details,pull-request-ref,fake-gh,fake-github}.ts', ['pr-tab.spec.ts']],
  // The merge gate, from the fake gate command and gh calls to the Gate tab and the header's Open PR and Merge.
  ['apps/desktop/src/renderer/src/gate/**', ['merge-gate.spec.ts']],
  ['apps/desktop/src/main/gates.ts', ['merge-gate.spec.ts']],
  ['packages/daemon/src/{gates,gate-actions,gate-output,gate-rules,worktrees}.ts', ['merge-gate.spec.ts']],
  ['packages/tracker/src/{pull-requests,pull-request-details,fake-gh,fake-github}.ts', ['merge-gate.spec.ts']],
  ['fixtures/gate/**', ['merge-gate.spec.ts']],
  // Questions and plans an agent puts to the user, from the board MCP to the inbox, the tile and the Plan tab.
  ['apps/desktop/src/renderer/src/plan/**', ['ask-plan.spec.ts']],
  ['apps/desktop/src/renderer/src/inbox/**', ['ask-plan.spec.ts']],
  ['apps/desktop/src/main/{asks,plan-lockdown,web-lockdown,web-tabs}.ts', ['ask-plan.spec.ts']],
  ['packages/daemon/src/{asks,board-mcp,board-mcp-http,board-ops,hook-ingress}.ts', ['ask-plan.spec.ts']],
];

/** The parts of the release config that name files: its rewrite rules, replaced and backported files, and section cuts. */
export interface ReleaseConfigPaths {
  sanitise: {
    rewrite: ReadonlyArray<{ paths?: readonly string[] }>;
    replace: Record<string, unknown>;
    backport: readonly string[];
    dropSections: ReadonlyArray<{ path: string }>;
  };
}

/** The files the release config names outright, so a change to one runs the test that checks the rules. A glob names no one file and is left out. */
export function releaseRulePaths(config: ReleaseConfigPaths): string[] {
  const { rewrite, replace, backport, dropSections } = config.sanitise;
  const named = [...rewrite.flatMap((rule) => rule.paths ?? []), ...Object.keys(replace), ...backport, ...dropSections.map((section) => section.path)];
  return [...new Set(named.filter((path) => !/[*?{}[\]!]/.test(path)))];
}

export interface Plan {
  /** True when the whole gate (`pnpm check:local`) is needed; the rest is then empty. */
  full: boolean;
  /** `vitest related` on these files. Empty means no unit run. */
  unit: string[];
  /** Spec file names under apps/desktop/e2e. Empty means no e2e run. */
  e2e: string[];
  visual: boolean;
  /** Desktop core changed: run the whole `unit` project (`vitest run --project unit`), not `vitest related`. */
  unitAll?: boolean;
  /** Desktop core changed: run every app e2e spec; `e2e` is then empty. */
  e2eAll?: boolean;
  /** With `unitAll`: the changed files whose tests can live in the `processes` project, for `vitest related --project processes`. */
  processes?: string[];
  /** With `e2eAll`: also the perf project (frame-time benchmark). */
  perf?: boolean;
  /** A recheck after a failed full run: every unit test of both projects (`pnpm test`), in place of `unit`. */
  testAll?: boolean;
  /** A recheck after failed shots: the visual run on just these spec files (under apps/desktop/e2e), when `visual` is false. */
  visualFiles?: string[];
  /** One line per decision, for the reviewer to check. */
  reasons: string[];
}

const matches = (file: string, globs: readonly string[]): boolean => globs.some((glob) => matchesGlob(file, glob));

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);
const isSpec = (file: string): boolean => /^apps\/desktop\/e2e\/[^/]+\.spec\.ts$/.test(file);
/** Specs that `playwright test --project app` does not run: playwright.config.ts gives them their own projects. */
const OTHER_PROJECT_SPECS = ['board-perf.spec.ts', 'packaged.spec.ts', 'readme-screenshots.spec.ts'];
/** A visual spec or its shared helpers, in apps/desktop/e2e/visual/: the visual step runs them, not the app project's e2e. */
const isVisualSpec = (file: string): boolean => /^apps\/desktop\/e2e\/visual\/[^/]+\.ts$/.test(file);
const specName = (file: string): string => file.split('/').pop() as string;
const isSnapshot = (file: string): boolean => file.startsWith('apps/desktop/e2e/visual.spec.ts-snapshots/');
const isRenderer = (file: string): boolean =>
  file.startsWith('apps/desktop/src/renderer/') && /\.(css|tsx?|html)$/.test(file) && !isTest(file);
const isAppSource = (file: string): boolean =>
  /^(apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file) && /\.(ts|tsx|html|json|sql)$/.test(file) && !isTest(file);

/**
 * Blast radius of a change to `apps/desktop`: it cannot reach the daemon, fake or tracker tests (no test in a package's `test` directory
 * imports anything from the desktop), so only the daemon-side core, the gate and shared config run the full gate. Desktop core,
 * which any desktop journey goes through, runs the whole `unit` project, all e2e specs and visual (docs/agents/testing-speed-spike.md, section 3).
 */
const isDesktopCore = (file: string): boolean => matches(file, DESKTOP_CORE_GLOBS) && !isTest(file);

/** Core files a frame-time regression comes from: `check:local` ran the perf project for every core change, and this is the only per-PR gate it has. */
const PERF_GLOBS = ['apps/desktop/src/renderer/src/{App,main}.tsx', 'apps/desktop/src/renderer/src/board/**/*.{ts,tsx}'];

/** The `unit` project's tests (vitest.config.ts), which a whole-unit run already covers. */
const isUnitProjectTest = (file: string): boolean =>
  isTest(file) && matches(file, ['apps/*/{src,test}/**', 'packages/*/src/**', 'scripts/release-public/leak-rules.test.ts']);

/** Whether `vitest related --project processes` can find anything for this file: nothing under `apps/desktop` is imported by that project's tests, and its own tests live in the packages' `test` directories and under `scripts`. */
const canReachProcesses = (file: string): boolean => !file.startsWith('apps/desktop/') && !isUnitProjectTest(file);

function widenForDesktopCore(plan: Plan, core: readonly string[]): void {
  plan.unitAll = true;
  plan.e2eAll = true;
  plan.e2e = [];
  plan.processes = plan.unit.filter(canReachProcesses);
  plan.reasons = plan.reasons.filter((reason) => !/^(e2e|unit): /.test(reason));
  plan.reasons.push(
    `unit: desktop core changed (${core.join(', ')}), so the whole unit project runs, and ${plan.processes.length > 0 ? `vitest related in the processes project on ${plan.processes.length} file(s)` : 'nothing else'}`,
    'e2e: desktop core changed, so every app spec runs',
  );
  if (core.some((file) => matches(file, PERF_GLOBS))) {
    plan.perf = true;
    plan.reasons.push('e2e: a board or app-shell core file changed, so the perf project runs too (check:local ran it; no other per-PR gate has it)');
  }
  if (core.some((file) => !file.startsWith('apps/desktop/src/main/')) && !plan.visual) {
    plan.visual = true;
    plan.reasons = plan.reasons.filter((reason) => !reason.startsWith('visual: '));
    plan.reasons.push('visual: a renderer, shared or preload core file changed');
  }
}

/**
 * `exists` says whether a changed path is still in the working tree (a deleted or renamed-away spec is not, and cannot run).
 * It defaults to true so the selection stays pure for callers that have no checkout.
 */
export function selectChecks(
  changed: readonly string[],
  exists: (file: string) => boolean = () => true,
  /** Files a release rule names, which `main.ts` reads from the release config; empty when there is none. */
  releaseRulePaths: readonly string[] = [],
): Plan {
  const files = [...new Set(changed)].sort();
  const plan: Plan = { full: false, unit: [], e2e: [], visual: false, reasons: [] };
  if (files.length === 0) {
    plan.reasons.push('no changed files: only lint, typecheck, markdownlint and knip');
    return plan;
  }

  const isRecognised = (file: string): boolean =>
    matches(file, NO_CHECK_GLOBS) || isTest(file) || isSpec(file) || isVisualSpec(file) || isSnapshot(file) || isAppSource(file) || isRenderer(file);
  const gate = files.filter(
    (file) =>
      (matches(file, FULL_GATE_GLOBS) && !isSpec(file)) ||
      matches(file, DAEMON_CORE_GLOBS) ||
      (isSpec(file) && file.endsWith('board-perf.spec.ts')) ||
      !isRecognised(file),
  );
  if (gate.length > 0) {
    plan.full = true;
    plan.reasons.push(`full gate: shared, core or unrecognised files changed (${gate.join(', ')})`);
    return plan;
  }

  plan.unit = files.filter((file) => /\.(ts|tsx|css|json)$/.test(file) && !file.startsWith('apps/desktop/e2e/') && !file.startsWith('docs/'));
  const changedCode = plan.unit.length;
  const scanned: string[] = [];
  for (const { tests, globs, why } of SCANNERS) {
    const named = globs === 'release' ? releaseRulePaths : globs === 'always' ? [] : globs;
    const hit = globs === 'always' ? changedCode > 0 : files.some((file) => (globs === 'release' ? matches(file, ['release/**']) || named.includes(file) : matches(file, named)));
    const add = tests.filter((test) => hit && exists(test) && !plan.unit.includes(test));
    if (add.length === 0) continue;
    plan.unit.push(...add);
    scanned.push(`${add.map((test) => test.split('/').pop()).join(', ')} (${why})`);
  }
  const related = changedCode > 0 ? `vitest related on ${changedCode} changed file(s)` : '';
  const scanners = scanned.length > 0 ? `the scanners: ${scanned.join('; ')}` : '';
  plan.reasons.push(related || scanners ? `unit: ${[related, scanners].filter(Boolean).join(', and ')}` : 'unit: skipped, no code changed');

  const specs = new Set<string>();
  for (const file of files.filter(isSpec)) {
    const name = specName(file);
    if (OTHER_PROJECT_SPECS.includes(name)) {
      plan.reasons.push(`e2e: ${file} runs in its own project, not in the app one; no gate step runs it`);
    } else if (!exists(file)) {
      plan.reasons.push(`e2e: ${file} was deleted or moved, so nothing to run`);
    } else {
      specs.add(name);
      plan.reasons.push(`e2e: ${file} changed, so it runs`);
    }
  }
  let smoke = false;
  for (const file of files.filter((f) => isAppSource(f))) {
    const mapped = E2E_MAP.filter(([glob]) => matchesGlob(file, glob)).flatMap(([, s]) => s);
    if (mapped.length === 0) {
      smoke = true;
      plan.reasons.push(`e2e: ${file} is in no map entry, so the smoke set runs`);
    } else {
      for (const spec of mapped) specs.add(spec);
      plan.reasons.push(`e2e: ${file} -> ${[...new Set(mapped)].join(', ')}`);
    }
  }
  if (smoke) for (const spec of SMOKE_SPECS) specs.add(spec);
  plan.e2e = [...specs].sort();
  if (plan.e2e.length === 0) plan.reasons.push('e2e: skipped, no app source or spec changed');

  const look = files.filter((file) => isRenderer(file) || isSnapshot(file) || isVisualSpec(file));
  plan.visual = look.length > 0;
  plan.reasons.push(plan.visual ? `visual: renderer code, styles, visual specs or baselines changed (${look.length} file(s))` : 'visual: skipped, no renderer file or baseline changed');
  const core = files.filter(isDesktopCore);
  if (core.length > 0) widenForDesktopCore(plan, core);
  return plan;
}
