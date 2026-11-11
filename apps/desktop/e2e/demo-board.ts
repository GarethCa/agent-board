import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import type { Agent, NewZoneParams, Zone } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tile } from './agent-helpers.ts';
import { pinRandomText } from './render.ts';

// The demo board the README's screenshots and other recordings draw: repos to put zones on, a fake claude that picks
// its scenario from each task, the board they seed, and the pins that keep what is random out of a picture.

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
