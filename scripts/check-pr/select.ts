/**
 * Which checks a PR needs, from the files it changes. Pure: `main.ts` feeds it `git diff` and runs the plan.
 *
 * The rules, in order:
 *  1. A change to the gate itself, the shared config, the e2e helpers, the fake CLIs, the daemon protocol, a heavily shared
 *     module (`CORE_GLOBS`) or any file nothing here recognises can break anything, so the plan is the full gate
 *     (`pnpm check:local`). Unknown means full: the fallback never runs less than it should.
 *  2. Unit tests: `vitest related` on the changed files.
 *  3. E2E: the specs the change maps to (`E2E_MAP`), plus any changed spec that still exists and runs in the `app` project. A changed app file that maps to nothing runs
 *     the smoke set. Tests, docs and scripts alone run no e2e.
 *  4. Visual: when anything under the renderer (styles, markup, layout code) or the baselines changed.
 */
import { matchesGlob } from 'node:path';

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
  'apps/desktop/src/shared/**',
  'apps/desktop/src/preload/**',
];

/** Run when an app file changes and no `E2E_MAP` entry claims it: the acceptance journey and a few core specs. */
/**
 * Modules nearly every journey goes through: a change here can break any spec, so it runs the full gate rather than the
 * smoke set. CSS is not in this list; a style change is covered by the visual tests.
 */
const CORE_GLOBS = [
  'apps/desktop/src/renderer/src/{App,main}.tsx',
  'apps/desktop/src/renderer/src/{harness,states,keys,errors,use-action}.ts',
  'apps/desktop/src/renderer/src/ui/**/*.{ts,tsx}',
  'apps/desktop/src/renderer/src/chrome/**/*.{ts,tsx}',
  'apps/desktop/src/renderer/src/board/{Board,commands,representations,TileNode,HybridTile}.tsx',
  'apps/desktop/src/renderer/src/board/{layout,tile,tiles}.ts',
  'apps/desktop/src/main/{index,items,view,setup}.ts',
  'packages/daemon/src/{rpc,params,index,daemon,sessions,agents,items,view-state,spawn,stop,permissions,subagents,worktrees,client}.ts',
  'packages/daemon/src/{harness-state,claude-state,codex-state,terminal-backend,terminal-input}.ts',
];

/** Files that need no check beyond lint, typecheck and the Markdown lint: docs, notes, the worker prompts and tooling with its own unit tests. */
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
];

export const SMOKE_SPECS = ['acceptance.spec.ts', 'app.spec.ts', 'tiles.spec.ts', 'session.spec.ts'];

/** Source globs to the specs that cover them. Every glob that matches a file adds its specs. */
export const E2E_MAP: ReadonlyArray<readonly [glob: string, specs: readonly string[]]> = [
  ['apps/desktop/src/renderer/src/board/*zone*', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Zone*', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*flow-edge*', ['flow-edges.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*FlowEdge*', ['flow-edges.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*rename*', ['rename.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*schedule*', ['schedules.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Schedule*', ['schedules.spec.ts']],
  ['apps/desktop/src/renderer/src/board/items/**', ['stickies.spec.ts', 'text-shapes.spec.ts', 'images-and-links.spec.ts']],
  ['apps/desktop/src/renderer/src/board/connectors/**', ['connectors.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Tile*', ['tiles.spec.ts', 'expanded-tile.spec.ts', 'tile-resize.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*tile*', ['tiles.spec.ts', 'expanded-tile.spec.ts', 'tile-resize.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*xpanded*', ['expanded-tile.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Agent*', ['agents.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*Issue*', ['trackers.spec.ts']],
  ['apps/desktop/src/renderer/src/board/*racker*', ['trackers.spec.ts']],
  ['apps/desktop/src/renderer/src/board/editing/**', ['selection.spec.ts', 'stickies.spec.ts']],
  ['apps/desktop/src/renderer/src/inbox/**', ['inbox.spec.ts']],
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
  ['apps/desktop/src/main/setup.ts', ['onboarding.spec.ts', 'board-cli.spec.ts']],
  ['packages/daemon/src/{repo-zone,git,pull-requests}.ts', ['zones.spec.ts', 'zoneless-agents.spec.ts']],
  ['packages/daemon/src/{daemon,lock,pid,cli,paths}.ts', ['daemon.spec.ts', 'daemon-reaping.spec.ts', 'reboot.spec.ts']],
  ['packages/daemon/src/{zones,zone-sources,tile-position}.ts', ['zones.spec.ts', 'add-zone.spec.ts', 'zoneless-agents.spec.ts']],
  ['packages/daemon/src/trackers.ts', ['trackers.spec.ts']],
  ['packages/daemon/src/{transcripts,transcript-adapters}.ts', ['chat-view.spec.ts']],
  ['packages/tracker/**', ['trackers.spec.ts']],
  // The PR tab (BI1), from the GitHub calls and the fake gh to the tab.
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
  ['packages/daemon/src/{asks,board-mcp,board-ops}.ts', ['ask-plan.spec.ts']],
];

export interface Plan {
  /** True when the whole gate (`pnpm check:local`) is needed; the rest is then empty. */
  full: boolean;
  /** `vitest related` on these files. Empty means no unit run. */
  unit: string[];
  /** Spec file names under apps/desktop/e2e. Empty means no e2e run. */
  e2e: string[];
  visual: boolean;
  /** One line per decision, for the reviewer to check. */
  reasons: string[];
}

const matches = (file: string, globs: readonly string[]): boolean => globs.some((glob) => matchesGlob(file, glob));

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);
const isSpec = (file: string): boolean => /^apps\/desktop\/e2e\/[^/]+\.spec\.ts$/.test(file);
/** Specs that `playwright test --project app` does not run: playwright.config.ts gives them their own projects. */
const OTHER_PROJECT_SPECS = ['visual.spec.ts', 'board-perf.spec.ts', 'packaged.spec.ts', 'readme-screenshots.spec.ts'];
const specName = (file: string): string => file.split('/').pop() as string;
const isSnapshot = (file: string): boolean => file.startsWith('apps/desktop/e2e/visual.spec.ts-snapshots/');
const isRenderer = (file: string): boolean =>
  file.startsWith('apps/desktop/src/renderer/') && /\.(css|tsx?|html)$/.test(file) && !isTest(file);
const isAppSource = (file: string): boolean =>
  /^(apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file) && /\.(ts|tsx|html|json|sql)$/.test(file) && !isTest(file);

/**
 * `exists` says whether a changed path is still in the working tree (a deleted or renamed-away spec is not, and cannot run).
 * It defaults to true so the selection stays pure for callers that have no checkout.
 */
export function selectChecks(changed: readonly string[], exists: (file: string) => boolean = () => true): Plan {
  const files = [...new Set(changed)].sort();
  const plan: Plan = { full: false, unit: [], e2e: [], visual: false, reasons: [] };
  if (files.length === 0) {
    plan.reasons.push('no changed files: only lint, typecheck and markdownlint');
    return plan;
  }

  const isRecognised = (file: string): boolean =>
    matches(file, NO_CHECK_GLOBS) || isTest(file) || isSpec(file) || isSnapshot(file) || isAppSource(file) || isRenderer(file);
  const gate = files.filter(
    (file) =>
      (matches(file, FULL_GATE_GLOBS) && !isSpec(file)) ||
      matches(file, CORE_GLOBS) ||
      (isSpec(file) && file.endsWith('board-perf.spec.ts')) ||
      !isRecognised(file),
  );
  if (gate.length > 0) {
    plan.full = true;
    plan.reasons.push(`full gate: shared, core or unrecognised files changed (${gate.join(', ')})`);
    return plan;
  }

  plan.unit = files.filter((file) => /\.(ts|tsx|css|json)$/.test(file) && !isSpec(file) && !file.startsWith('docs/'));
  plan.reasons.push(
    plan.unit.length > 0 ? `unit: vitest related on ${plan.unit.length} changed file(s)` : 'unit: skipped, no code changed',
  );

  const specs = new Set<string>();
  for (const file of files.filter(isSpec)) {
    const name = specName(file);
    if (OTHER_PROJECT_SPECS.includes(name)) {
      plan.reasons.push(`e2e: ${file} runs in its own project, not in the app one; ${name === 'visual.spec.ts' ? 'the visual step covers it' : 'no gate step runs it'}`);
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

  const look = files.filter((file) => isRenderer(file) || isSnapshot(file) || file === 'apps/desktop/e2e/visual.spec.ts');
  plan.visual = look.length > 0;
  plan.reasons.push(plan.visual ? `visual: renderer code, styles or baselines changed (${look.length} file(s))` : 'visual: skipped, no renderer file or baseline changed');
  return plan;
}
