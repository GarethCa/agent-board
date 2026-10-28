import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import type { Agent, NewZoneParams, Zone } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tile } from './agent-helpers.ts';
import { pinRandomText } from './render.ts';

// The demo board the README's screenshots and the board recordings share: repos to put zones on, a fake claude that
// picks its scenario from each task, the board they seed, and the pins that keep what is random out of a picture.

/** Waits until the board's view and every node on it have stopped moving (Fit View and an expanding tile animate), so the shot never catches a frame part-way. */
export async function stillBoard(page: Page): Promise<void> {
  let last = '';
  let stable = 0;
  await expect
    .poll(async () => {
      const now = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.react-flow__viewport, .react-flow__node')]
          .map((element) => `${element.style.transform}|${JSON.stringify(element.getBoundingClientRect())}`)
          .join(';'),
      );
      stable = now === last ? stable + 1 : 0;
      last = now;
      return stable;
    }, { intervals: [100] })
    .toBeGreaterThanOrEqual(5);
}

/**
 * A `claude` that picks the fake's scenario from where it runs, so one board holds agents in every state. Claude takes
 * its first message at its prompt, not on its command line, so each picks by its folder: a worktree named for its task
 * under its repo's folder (`web-app`, `api-service`, or the one repo of a single-zone shot). The rest of the fake is untouched.
 */
export function scenarioPicker(dir: string): string {
  const bin = join(dir, 'picker-bin');
  mkdirSync(bin);
  const script = `#!/bin/sh
case "$PWD" in
  */web-app-*/pick-a-cache*) FAKE_HARNESS_SCENARIO=waiting ;;
  */web-app-*/clear-build-output*) FAKE_HARNESS_SCENARIO=permission ;;
  */api-service-*/prune-old-jobs*) FAKE_HARNESS_SCENARIO=subagent-ask FAKE_HARNESS_SUBAGENT_WORK_MS=600000 ;;
  *-review-r[0-9]*) FAKE_HARNESS_SCENARIO=review ;;
  */lead-two-*) FAKE_HARNESS_SCENARIO=orchestrate ;;
  */pick-a-cache*) FAKE_HARNESS_SCENARIO=orchestrate ;;
  */write-the-release-plan*) FAKE_HARNESS_SCENARIO=orchestrate ;;
  */migrate-the-orders-table*) FAKE_HARNESS_SCENARIO=orchestrate FAKE_HARNESS_RATE_LIMIT_SCREEN=menu-credits-first ;;
  */api-service-*/trace-session-store* | */web-app-*/resize-images*) FAKE_HARNESS_SCENARIO=subagents-working FAKE_HARNESS_SUBAGENT_WORK_MS=600000 ;;
  *) FAKE_HARNESS_SCENARIO=output FAKE_HARNESS_IDLE_NOTIFY_MS=600000 ;;
esac
export FAKE_HARNESS_SCENARIO FAKE_HARNESS_SUBAGENT_WORK_MS FAKE_HARNESS_IDLE_NOTIFY_MS FAKE_HARNESS_RATE_LIMIT_SCREEN
# The board types the first message at the prompt: with echo on, the terminal would show its paste markers. Only here, not in
# the fake for every session: a draft left unsent at the prompt is found by its echo.
stty -echo 2>/dev/null
exec "${join(fakeBinDir, 'claude')}" "$@"
`;
  writeFileSync(join(bin, 'claude'), script);
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

/**
 * Rewrites the machine's own paths in the page's text (temp folders, this checkout) to ordinary ones, so no shot shows
 * where it was made. Nothing else is touched: the app's labels, versions and states are what it drew.
 */
export async function pinPaths(page: Page): Promise<void> {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      node.data = node.data
        .replace(/\/(?:private\/)?(?:var|Users)\/\S*?\/(claude|codex)(?=\s|$|…)/g, '/usr/local/bin/$1')
        .replace(/\/(?:private\/)?(?:var|Users)\/\S*?\/gh(?=\s|$|…)/g, '/opt/homebrew/bin/gh')
        .replace(/\/(?:private\/)?(?:var|Users)\/\S*?\/repos\/(\S+?)(?=\s|$|…)/g, '~/agent-board/repos/$1')
        .replace(/\/(?:private\/)?(?:var|Users)\/[^\s…]*…?/g, '~/code/…');
    }
  });
}

/**
 * What differs from run to run, fixed, so that drawing the shots again on an unchanged UI gives the same pixels: the
 * random suffix of each branch (a short hash of the rest, which is what it looks like), and the seconds a permission
 * request has waited.
 */
export async function pinRandomLooks(page: Page): Promise<void> {
  await pinRandomText(page);
  // The seconds left on a held permission request tick on every second: drawn as a fixed "12 s" in their place.
  await page.addStyleTag({
    content: `.inbox-prompt-countdown { visibility: hidden; position: relative; }
      .inbox-prompt-countdown::after { content: '12 s'; visibility: visible; position: absolute; left: 0; top: 0; white-space: nowrap; }`,
  });
  await page.evaluate(() => {
    // Subagents started together start in either order: perched in the order of their labels, as one run had them.
    for (const perch of document.querySelectorAll("[data-testid='subagent-perch']")) {
      const label = (child: Element) => child.querySelector('svg')?.getAttribute('aria-label') ?? '';
      for (const child of [...perch.children].sort((a, b) => label(a).localeCompare(label(b)))) perch.append(child);
    }
    // The time a review round came in is the clock's: drawn as a fixed one.
    for (const when of document.querySelectorAll('.review-round-when')) when.textContent = when.textContent!.replace(/\d{1,2}:\d{2} [AP]M/, '9:41 AM');
    // The times an edge's history lists are the clock's too.
    for (const when of document.querySelectorAll('.edge-rules-history time')) when.textContent = when.textContent!.replace(/\d{1,2}:\d{2}/, '9:41');
    const hash = (text: string) => {
      let value = 0;
      for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
      return value.toString(16).padStart(8, '0').slice(0, 6);
    };
    // A reviewer's tile says which branch it reviews, in words that still carry that branch's random suffix.
    for (const tile of document.querySelectorAll("[data-testid='agent-tile']")) {
      const words = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
      while (words.nextNode()) {
        const node = words.currentNode as Text;
        node.data = node.data.replace(/\b([a-z][a-z0-9-]*?)-[0-9a-f]{6}\b(?!-)/g, (_all, slug: string) => `${slug}-000000`);
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      // `pinRandomText` (render.ts) has set every branch's random suffix to six zeros: give each a hash of its own name.
      node.data = node.data.replace(/([a-z][a-z0-9-]*)-000000/g, (_all, slug: string) => `${slug}-${hash(slug)}`);
    }
  });
}

/** A repo called `name` under `dir` with one commit. */
export function makeRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '--quiet', '-m', 'initial');
  return repo;
}

/** Zones, agents, stickies, a shape, a text and two connectors: a board someone has been using for a day. */
export async function seedBoard(page: Page, dir: string): Promise<void> {
  const zones = await page.evaluate(
    async ({ web, api }) => {
      const added = async (path: string, params: NewZoneParams) => {
        const result = await window.agentBoard.zones.addFolder(path, params);
        if (result.status !== 'added') throw new Error(result.message);
        return result.zone;
      };
      return {
        web: await added(web, { x: 0, y: 0, width: 840, height: 440, color: '#4c6ef5' }),
        api: await added(api, { x: 920, y: 0, width: 640, height: 440, color: '#12b886' }),
      };
    },
    { web: makeRepo(dir, 'web-app'), api: makeRepo(dir, 'api-service') },
  );
  const spawn = (zone: Zone, prompt: string, x: number, y: number) =>
    page.evaluate(
      async (params) => {
        const result = await window.agentBoard.agents.spawn(params);
        if (result.status !== 'started') throw new Error(result.message);
        return result.agent;
      },
      { zoneId: zone.id, prompt, position: { x, y }, cols: 100, rows: 30 },
    );
  const agents: Agent[] = [];
  // Short tasks: the tile's name, branch and message all come from them, and must fit.
  const flagged = (name: string) =>
    expect(tile(page).filter({ has: page.getByText(name, { exact: true }) })).toHaveAttribute('data-needs-you', 'true', { timeout: 30_000 });
  agents.push(await spawn(zones.web, 'Fix checkout flake', 30, 60));
  // The inbox lists what needs you oldest first: each of the three is spawned once the one before has raised its flag.
  agents.push(await spawn(zones.web, 'Pick a cache', 480, 60));
  await flagged('Pick a cache');
  agents.push(await spawn(zones.web, 'Clear build output', 30, 240));
  await flagged('Clear build output');
  agents.push(await spawn(zones.web, 'Resize images', 480, 240));
  agents.push(await spawn(zones.api, 'Prune old jobs', 30, 60));
  await flagged('Prune old jobs');
  agents.push(await spawn(zones.api, 'Trace session store', 340, 60));

  const item = (params: object) => page.evaluate((p) => window.agentBoard.items.create(p as never), params);
  await item({
    kind: 'sticky',
    zoneId: zones.api.id,
    x: 30,
    y: 250,
    width: 230,
    height: 150,
    data: { text: '**Ship Friday**\n\n- checkout fix\n- cache decision', color: '#fff3a3' },
  });
  const rule = await item({
    kind: 'sticky',
    zoneId: null,
    x: 40,
    y: 520,
    width: 230,
    height: 130,
    data: { text: 'Review every PR **before** it merges', color: '#ffd8a8' },
  });
  const shape = await item({
    kind: 'shape',
    zoneId: null,
    x: 500,
    y: 550,
    width: 220,
    height: 90,
    data: { shape: 'rounded', fill: '#d0ebff', stroke: '#3b5bdb', strokeWidth: 2.5, dashed: false, text: 'Release 1.0', textSize: 'body', bold: true, textColor: '#2b2a27' },
  });
  await item({
    kind: 'text',
    zoneId: null,
    x: 20,
    y: -90,
    width: 420,
    height: 50,
    data: { text: 'Launch week', size: 'h1', bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: false },
  });
  await page.evaluate(
    async ({ from, to, ruleId, shapeId }) => {
      await window.agentBoard.connectors.create({
        from: { type: 'agent', id: from, side: 'right' },
        to: { type: 'agent', id: to, side: 'left' },
        label: 'hands off',
      });
      await window.agentBoard.connectors.create({ from: { type: 'item', id: ruleId, side: 'right' }, to: { type: 'item', id: shapeId, side: 'left' } });
    },
    { from: agents[0]!.sessionId, to: agents[1]!.sessionId, ruleId: rule.id, shapeId: shape.id },
  );
}

/**
 * Waits, on conditions and not on time, until every tile of the demo board shows what it will be shot with: its state, the
 * exact command or question it is stuck on, its subagents' characters, and the Needs-you count. The agents run on their own
 * clocks, so a shot taken before this could catch one a moment early.
 */
export async function demoReady(page: Page): Promise<void> {
  const named = (name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });
  const within = { timeout: 30_000 };
  await expect(named('Fix checkout flake')).toHaveAttribute('data-state', 'idle', within);
  // A tile says what its agent is doing, not the question or command it is stuck on: those are in the inbox below.
  await expect(named('Pick a cache')).toHaveAttribute('data-needs-you', 'true', within);
  await expect(named('Clear build output')).toHaveAttribute('data-needs-you', 'true', within);
  await expect(named('Prune old jobs')).toHaveAttribute('data-needs-you', 'true', within);
  await expect(named('Prune old jobs').getByTestId('character')).toHaveCount(2, within);
  await expect(named('Resize images').getByTestId('character')).toHaveCount(3, within);
  await expect(named('Trace session store').getByTestId('character')).toHaveCount(3, within);
  await expect(page.getByTestId('inbox-count')).toContainText('3 need you', within);
}

/**
 * A `claude` and a `codex` that pick their scenario for the promo board: the `demo-*` story drawn as the real TUIs look,
 * typed a character at a time. Claude takes its first message at its prompt, not on its command line, so each picks by
 * its folder, a worktree named for its agent (`PROMO_AGENTS`); a review round's reviewer works in one named for its
 * round. The crowd's agents (`seedCrowd`) finish one short turn. Anything else waits at its prompt as a reviewer, as
 * the one a hand-off starts does.
 */
function promoPicker(dir: string, { typeMs, subagentWorkMs }: { typeMs: number; subagentWorkMs: number }): string {
  const bin = join(dir, 'promo-bin');
  mkdirSync(bin);
  for (const harness of ['claude', 'codex']) {
    const script = `#!/bin/sh
FAKE_HARNESS_TYPE_MS=${typeMs}
case "$PWD" in
  *-review-r[0-9]*) FAKE_HARNESS_SCENARIO=demo-review ;;
  */plan-discount-codes*) FAKE_HARNESS_SCENARIO=demo-plan ;;
  */apply-discount-codes*) FAKE_HARNESS_SCENARIO=demo-implement FAKE_HARNESS_SUBAGENT_WORK_MS=${subagentWorkMs} ;;
  */add-refund-idempotency*) FAKE_HARNESS_SCENARIO=demo-codex ;;
  */plan-the-zone-id-move*) FAKE_HARNESS_SCENARIO=ask-plan ;;
  */retry-failed-webhooks*) FAKE_HARNESS_SCENARIO=subagents-working FAKE_HARNESS_SUBAGENT_WORK_MS=600000 ;;
  */design-system-*/* | */mobile-app-*/* | */data-pipeline-*/*) FAKE_HARNESS_SCENARIO=output FAKE_HARNESS_IDLE_NOTIFY_MS=600000 FAKE_HARNESS_TYPE_MS=0 ;;
  *) FAKE_HARNESS_SCENARIO=demo-review ;;
esac
export FAKE_HARNESS_SCENARIO FAKE_HARNESS_SUBAGENT_WORK_MS FAKE_HARNESS_IDLE_NOTIFY_MS FAKE_HARNESS_TYPE_MS
exec "${join(fakeBinDir, harness)}" "$@"
`;
    writeFileSync(join(bin, harness), script);
    chmodSync(join(bin, harness), 0o755);
  }
  return bin;
}

/** The promo board's agents, each named for its work and steered by its task (`promoPicker`). */
export const PROMO_AGENTS = {
  planner: { zone: 'storefront', name: 'Plan discount codes', prompt: 'Plan discount codes for ACME-12', x: 40, y: 70 },
  implementer: { zone: 'storefront', name: 'Apply discount codes', prompt: 'Apply discount codes: ACME-12', x: 500, y: 70 },
  // No task: it waits at its prompt for the implementer's hand-off, then reviews it.
  reviewer: { zone: 'storefront', name: 'Review discount codes', prompt: undefined, x: 960, y: 70 },
  refunds: { zone: 'billing-api', name: 'Add refund idempotency', prompt: 'Add refund idempotency keys', x: 40, y: 70, harness: 'codex' },
  payouts: { zone: 'billing-api', name: 'Plan the zone id move', prompt: 'Plan doc on the board: docs/migration.md', x: 40, y: 330 },
  webhooks: { zone: 'billing-api', name: 'Retry failed webhooks', prompt: 'Retry failed webhooks', x: 500, y: 70 },
} as const;
export type PromoAgent = keyof typeof PROMO_AGENTS;

/** The promo board as seeded: its zones and agents by name. */
export interface PromoBoard {
  zones: Record<'storefront' | 'billing-api', Zone>;
  agents: Partial<Record<PromoAgent, Agent>>;
}

/** How fast the promo board's agents go: how long each typed character takes, and how long the implementer's explorer works. */
export interface PromoPace {
  typeMs?: number;
  subagentWorkMs?: number;
}

/**
 * The environment that runs the promo board's agents on the fakes, from `scratch`'s, with its own picker first on PATH.
 * Their worktrees are where the app keeps them, under the home folder, so a TUI's welcome box shows a short `~/` path,
 * not the machine's temp folder.
 */
export function promoEnv(dir: string, env: Record<string, string>, { typeMs = 12, subagentWorkMs = 6_000 }: PromoPace = {}): Record<string, string> {
  return { ...env, PATH: `${promoPicker(dir, { typeMs, subagentWorkMs })}:${env.PATH}`, AGENT_BOARD_WORKTREES_DIR: join(env.HOME!, '.agent-board', 'worktrees') };
}

/** A Mermaid flowchart of the story the board tells, pasted onto the board where the pointer is. */
const STORY_DIAGRAM = ['```mermaid', 'flowchart LR', '  plan[Plan] --> code[Implement]', '  code --> review{Review}', '  review -- changes --> code', '  review -- approved --> ship([Ship])', '```'].join('\n');

/** Starts the promo agent `key` on `board`, where the board lays it out. */
export async function spawnPromoAgent(page: Page, board: PromoBoard, key: PromoAgent): Promise<Agent> {
  const spec = PROMO_AGENTS[key];
  const agent = await page.evaluate(
    async (params) => {
      const result = await window.agentBoard.agents.spawn(params);
      if (result.status !== 'started') throw new Error(result.message);
      return result.agent;
    },
    {
      zoneId: board.zones[spec.zone].id,
      name: spec.name,
      ...(spec.prompt === undefined ? { noTemplate: true } : { prompt: spec.prompt }),
      ...('harness' in spec ? { harness: spec.harness } : {}),
      position: { x: spec.x, y: spec.y },
      cols: 100,
      rows: 30,
    },
  );
  board.agents[key] = agent;
  return agent;
}

/**
 * The board the promo is shot on, in the Workbench light theme: a `storefront` zone where a planner, an implementer and
 * a reviewer pass plan.md and handover.md along flow edges, and a `billing-api` zone with a Codex agent, an agent whose
 * plan waits on the board, and one whose subagents run. A Mermaid flowchart of the story, a sticky note and the
 * planner's clock sit round them. `later` names agents left for the spec to start on camera.
 */
export async function seedPromoBoard(page: Page, dir: string, { later = [] }: { later?: PromoAgent[] } = {}): Promise<PromoBoard> {
  const zones = await page.evaluate(
    async ({ storefront, billing }) => {
      const added = async (path: string, params: NewZoneParams) => {
        const result = await window.agentBoard.zones.addFolder(path, params);
        if (result.status !== 'added') throw new Error(result.message);
        return result.zone;
      };
      return {
        storefront: await added(storefront, { x: 0, y: 0, width: 1400, height: 330, color: '#4c6ef5' }),
        'billing-api': await added(billing, { x: 1500, y: 0, width: 940, height: 600, color: '#12b886' }),
      };
    },
    { storefront: makeRepo(dir, 'storefront'), billing: makeRepo(dir, 'billing-api') },
  );
  const board: PromoBoard = { zones, agents: {} };
  for (const key of Object.keys(PROMO_AGENTS) as PromoAgent[]) if (!later.includes(key)) await spawnPromoAgent(page, board, key);
  const { planner, implementer, reviewer } = board.agents;
  if (planner === undefined || reviewer === undefined) throw new Error('the promo board needs its planner and reviewer');

  await page.evaluate(
    async ({ planner, implementer, reviewer }) => {
      const board = window.agentBoard;
      // The plan waits for a Send; the handover goes to the reviewer as the implementer's turn ends. Without the
      // implementer (a shot that starts it on camera), there is nothing to join.
      if (implementer !== undefined) {
        await board.flowEdges.create({ from: planner, to: implementer, payload: 'handover', path: 'plan.md', trigger: 'manual' });
        await board.flowEdges.create({ from: implementer, to: reviewer, payload: 'handover', path: '.agent-board/handover.md' });
      }
      await board.items.create({
        kind: 'sticky',
        zoneId: null,
        x: 1040,
        y: 400,
        width: 260,
        height: 150,
        data: { text: '**Ship Friday**\n\n- discount codes\n- refund retries', color: '#fff3a3' },
      });
      await board.items.create({
        kind: 'text',
        zoneId: null,
        x: 20,
        y: -90,
        width: 420,
        height: 50,
        data: { text: 'Launch week', size: 'h1', bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: false },
      });
    },
    { planner: planner.sessionId, implementer: implementer?.sessionId, reviewer: reviewer.sessionId },
  );
  await pasteMermaid(page, STORY_DIAGRAM, { x: 40, y: 420 });
  // Its plan written, the planner rests until the morning: a clock beside it. A schedule puts its agent to sleep, so
  // only one whose work is done takes one.
  await expect.poll(() => existsSync(join(planner.worktree, 'plan.md')), { timeout: 60_000 }).toBe(true);
  await expect(tile(page).filter({ has: page.getByText(PROMO_AGENTS.planner.name, { exact: true }) })).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 });
  await page.evaluate((id) => window.agentBoard.agents.setSchedule(id, { cron: '0 9 * * 1-5', prompt: 'Plan the next issue in the cycle' }), planner.sessionId);
  // The clock comes beside its tile, over the plan's edge: moved below the tile instead (the storefront is at the origin).
  const clock = async () => (await page.evaluate(() => window.agentBoard.items.list())).find((item) => item.kind === 'clock');
  await expect.poll(async () => (await clock()) !== undefined, { timeout: 10_000, message: 'the planner’s schedule put a clock on the board' }).toBe(true);
  await page.evaluate(({ id, x, y }) => window.agentBoard.items.update({ id, x, y }), { id: (await clock())!.id, x: PROMO_AGENTS.planner.x, y: PROMO_AGENTS.planner.y + 150 });
  return board;
}

/** Pastes `text` onto the board with its top left at `at`, in board coordinates, as the paste shortcut does with the clipboard's text. */
async function pasteMermaid(page: Page, text: string, at: { x: number; y: number }): Promise<void> {
  // Counted where they are kept: the board draws only the shapes in view.
  const shapes = () => page.evaluate(async () => (await window.agentBoard.items.list()).filter((item) => item.kind === 'shape').length);
  const before = await shapes();
  // A paste lands where the pointer is: the board is framed so that `at` is under it.
  await page.evaluate(() => window.__demo?.camera?.({ x: 0, y: 0, width: 1600, height: 900 }, 0));
  const point = await page.locator('.react-flow__viewport').evaluate((viewport, { x, y }) => {
    const { a: zoom, e: dx, f: dy } = new DOMMatrix(getComputedStyle(viewport).transform);
    const box = viewport.parentElement!.getBoundingClientRect();
    return { x: box.x + dx + x * zoom, y: box.y + dy + y * zoom };
  }, at);
  await page.mouse.move(point.x, point.y);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await expect.poll(shapes).toBe(before + 4);
  // Pasted shapes come selected: a click on the empty board above them leaves nothing selected on camera.
  await page.mouse.click(point.x, point.y - 30);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
}

/**
 * Waits, on conditions, until the promo board shows what its first shot opens on: the plan on its edge, the implementer
 * and the Codex agent each stopped on a permission, the plan card waiting, the webhooks agent's subagents at work, and
 * the inbox's count.
 */
export async function promoReady(page: Page, board: PromoBoard): Promise<void> {
  const named = (key: PromoAgent) => tile(page).filter({ has: page.getByText(PROMO_AGENTS[key].name, { exact: true }) });
  const within = { timeout: 60_000 };
  // The board draws only what is in view: all of it, for these.
  await page.getByRole('button', { name: 'Fit View' }).click();
  await expect(page.getByTestId('rail-token').filter({ hasText: 'plan.md' })).toHaveCount(1, within);
  await expect(named('implementer')).toHaveAttribute('data-needs-you', 'true', within);
  await expect(named('refunds')).toHaveAttribute('data-needs-you', 'true', within);
  await expect(page.getByTestId('plan-card')).toBeVisible(within);
  if (board.agents.webhooks !== undefined) await expect(named('webhooks').getByTestId('character')).toHaveCount(3, within);
  await expect(page.getByTestId('inbox-count')).toContainText('3 need you', within);
}

/** The promo agent `key`'s tile. */
export const promoTile = (page: Page, key: PromoAgent) => tile(page).filter({ has: page.getByText(PROMO_AGENTS[key].name, { exact: true }) });

/** The crowd's zones, below the promo board, and the tasks of each one's agents. */
const CROWD = [
  { repo: 'design-system', color: '#7048e8', tasks: ['Tokens for dark mode', 'Fix focus rings', 'Button sizes audit', 'Icon set refresh'] },
  { repo: 'mobile-app', color: '#f76707', tasks: ['Offline cart sync', 'Push opt-in screen', 'Crash on resume', 'Deep link routing'] },
  { repo: 'data-pipeline', color: '#1098ad', tasks: ['Backfill orders', 'Dedupe events', 'Nightly export', 'Schema drift alert'] },
] as const;

/** Three more zones of four agents each below the promo board, for a board that shows it scales. */
export async function seedCrowd(page: Page, dir: string): Promise<void> {
  for (const [index, { repo, color, tasks }] of CROWD.entries()) {
    const zone = await page.evaluate(
      async ({ path, params }) => {
        const result = await window.agentBoard.zones.addFolder(path, params);
        if (result.status !== 'added') throw new Error(result.message);
        return result.zone;
      },
      { path: makeRepo(dir, repo), params: { x: index * 860, y: 760, width: 800, height: 360, color } },
    );
    for (const [at, task] of tasks.entries()) {
      await page.evaluate(
        async (params) => {
          const result = await window.agentBoard.agents.spawn(params);
          if (result.status !== 'started') throw new Error(result.message);
        },
        { zoneId: zone.id, name: task, prompt: task, position: { x: 30 + (at % 2) * 390, y: 60 + Math.floor(at / 2) * 150 }, cols: 100, rows: 30 },
      );
    }
  }
  // Counted where they are kept: the board draws only the tiles in view.
  await expect.poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).length, { timeout: 60_000 }).toBe(Object.keys(PROMO_AGENTS).length + CROWD.length * 4);
}
