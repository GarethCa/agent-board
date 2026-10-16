import { describe, expect, it } from 'vitest';
import { E2E_MAP, SMOKE_SPECS, selectChecks } from './select.ts';

describe('selectChecks', () => {
  it('runs only lint-level checks for a docs change', () => {
    const plan = selectChecks(['docs/BRIEF.md', 'CONTRIBUTING.md']);
    expect(plan).toMatchObject({ full: false, unit: [], e2e: [], visual: false });
  });

  it('runs related unit tests and visual, but no e2e, for a CSS-only change', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/app.css']);
    expect(plan.full).toBe(false);
    expect(plan.unit).toEqual(['apps/desktop/src/renderer/src/app.css']);
    expect(plan.visual).toBe(true);
    expect(plan.e2e).toEqual([]);
  });

  it('maps a daemon file to its specs, with no visual run', () => {
    const plan = selectChecks(['packages/daemon/src/flow-edges.ts']);
    expect(plan.e2e).toEqual(['flow-edges.spec.ts']);
    expect(plan.visual).toBe(false);
    expect(plan.unit).toEqual(['packages/daemon/src/flow-edges.ts']);
  });

  it('maps renderer zone files to the zone specs', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/board/zone-nodes.ts']);
    expect(plan.e2e).toEqual(['add-zone.spec.ts', 'zoneless-agents.spec.ts', 'zones.spec.ts']);
  });

  it('runs the smoke set for an unmapped, non-core app file', () => {
    const plan = selectChecks(['apps/desktop/src/renderer/src/Gallery.tsx']);
    expect(plan.e2e).toEqual([...SMOKE_SPECS].sort());
    expect(plan.visual).toBe(true);
  });

  it('adds the smoke set to the mapped specs when one file is unmapped', () => {
    const plan = selectChecks(['packages/daemon/src/flow-edges.ts', 'packages/daemon/src/counts.ts']);
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
    expect(selectChecks(['apps/desktop/e2e/visual.spec.ts']).visual).toBe(true);
  });

  it('runs nothing for the on-request Linux visual tooling', () => {
    for (const file of ['scripts/visual-linux.sh', 'docker/visual-linux/Dockerfile']) {
      const plan = selectChecks([file]);
      expect(plan).toMatchObject({ full: false, unit: [], e2e: [], visual: false });
    }
  });

  it('does not run e2e for a unit test change', () => {
    const plan = selectChecks(['packages/daemon/src/cron.test.ts']);
    expect(plan.e2e).toEqual([]);
    expect(plan.unit).toEqual(['packages/daemon/src/cron.test.ts']);
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
    'apps/desktop/src/shared/anything.ts',
  ])('falls back to the full gate when %s changes', (file) => {
    const plan = selectChecks([file, 'apps/desktop/src/renderer/src/app.css']);
    expect(plan).toMatchObject({ full: true, unit: [], e2e: [], visual: false });
    expect(plan.reasons[0]).toContain(file);
  });

  it('does not run a deleted spec, nor one that is not in the app project', () => {
    const exists = (file: string): boolean => !file.endsWith('gone.spec.ts');
    const plan = selectChecks(['apps/desktop/e2e/gone.spec.ts', 'apps/desktop/e2e/visual.spec.ts', 'apps/desktop/e2e/packaged.spec.ts'], exists);
    expect(plan.e2e).toEqual([]);
    expect(plan.visual).toBe(true);
    expect(plan.full).toBe(false);
  });

  it('runs the full gate when the key registry changes, which every surface matches its keys through', () => {
    expect(selectChecks(['apps/desktop/src/renderer/src/keys/registry.ts']).full).toBe(true);
    expect(selectChecks(['apps/desktop/src/renderer/src/keys/index.ts']).full).toBe(true);
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

  it.each([
    'packages/daemon/src/items.ts',
    'packages/daemon/src/rpc.ts',
    'packages/daemon/src/sessions.ts',
    'packages/daemon/src/migrate.ts',
    'apps/desktop/src/renderer/src/board/Board.tsx',
    'apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/src/renderer/src/ui/Dialog.tsx',
    'apps/desktop/src/renderer/src/chrome/BoardChrome.tsx',
    'packages/daemon/src/board-layout.ts',
    'apps/desktop/src/main/index.ts',
  ])('runs the full gate for the widely shared module %s', (file) => {
    expect(selectChecks([file]).full).toBe(true);
  });

  it.each([
    'packages/daemon/src/agent-spawns.ts',
    'packages/daemon/src/agent-lifecycle.ts',
    'packages/daemon/src/hook-states.ts',
    'packages/daemon/src/deliveries.ts',
  ])('runs the full gate for %s, split out of the agent host', (file) => {
    expect(selectChecks([file]).full).toBe(true);
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
      '.claude/skills/cmux-workers/worker.sh',
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
