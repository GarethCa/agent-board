import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import type { Agent, NewZoneParams, Zone } from '@agent-board/daemon/protocol';
import { createFakeGitHub, createTempKeychain, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { agents, launch, screen, sessionWindow, setClickOpens, tile, tileAction } from './agent-helpers.ts';
import { openAddZone, removeDataDir, tempDataDir, test } from './launch.ts';
import { ignorePointer, pinRandomText, RENDER_ARGS, RENDER_ENV, settle, VIEWPORT } from './render.ts';
import { scratch } from './scratch.ts';

// The README's screenshots, made by `pnpm readme:screenshots`. The app runs on the fake claude with a seeded demo
// board, drawn the way the visual spec draws it (./render.ts: software rendering, one device pixel per CSS pixel, motion
// off, a fixed locale and time zone). Unlike the visual spec the fonts are the app's own, so the shots show its real look.
// Light theme, but for one shot of the board in the dark one. Each PNG is recompressed to a small palette before it is written to docs/assets/screenshots/.
test.use({ viewport: null });

const OUT = join(import.meta.dirname, '..', '..', '..', 'docs', 'assets', 'screenshots');

/** Writes `png` to `docs/assets/screenshots/<name>.png`, quantised: UI flat colours take a fraction of the bytes. */
async function write(name: string, png: Buffer): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await sharp(png).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(join(OUT, `${name}.png`));
}

/** Waits until the board's view and every node on it have stopped moving (Fit View and an expanding tile animate), so the shot never catches a frame part-way. */
async function stillBoard(page: Page): Promise<void> {
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

/** Shoots the whole window once the page is still. Taken through the DevTools protocol, scaled to two device pixels per CSS pixel for retina screens: Playwright's own screenshot of an Electron window is at one. */
async function shoot(page: Page, name: string): Promise<void> {
  const restorePointer = await ignorePointer(page);
  await settle(page);
  await stillBoard(page);
  const session = await page.context().newCDPSession(page);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, ...VIEWPORT, scale: 2 } });
  await session.detach();
  await write(name, Buffer.from(data, 'base64'));
  await restorePointer();
}

/**
 * A `claude` that picks the fake's scenario from the task, so one board holds agents in every state. Each task's words
 * choose the scenario; the rest of the fake is untouched.
 */
function scenarioPicker(dir: string): string {
  const bin = join(dir, 'picker-bin');
  mkdirSync(bin);
  const script = `#!/bin/sh
case "$*" in
  *"Pick a cache"*) FAKE_HARNESS_SCENARIO=waiting ;;
  *"Clear build output"*) FAKE_HARNESS_SCENARIO=permission ;;
  *"Prune old jobs"*) FAKE_HARNESS_SCENARIO=subagent-ask FAKE_HARNESS_SUBAGENT_WORK_MS=600000 ;;
  *"reviewer for round"*) FAKE_HARNESS_SCENARIO=review ;;
  *"Trace session store"* | *"Resize images"*) FAKE_HARNESS_SCENARIO=subagents-working FAKE_HARNESS_SUBAGENT_WORK_MS=600000 ;;
  *) FAKE_HARNESS_SCENARIO=output FAKE_HARNESS_IDLE_NOTIFY_MS=600000 ;;
esac
export FAKE_HARNESS_SCENARIO FAKE_HARNESS_SUBAGENT_WORK_MS FAKE_HARNESS_IDLE_NOTIFY_MS
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
async function pinPaths(page: Page): Promise<void> {
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
 * What differs from run to run, fixed, so that drawing the shots again on an unchanged UI gives the same pixels: the tilt
 * of each tile (it comes from a random id; here from its name, so tiles still lean different ways), the random suffix of
 * each branch (a short hash of the rest, which is what it looks like), and the seconds a permission request has waited.
 */
async function pinRandomLooks(page: Page): Promise<void> {
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
    const hash = (text: string) => {
      let value = 0;
      for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
      return value.toString(16).padStart(8, '0').slice(0, 6);
    };
    const tilts = ['-1.2deg', '0.8deg', '-0.5deg', '1.1deg', '-0.9deg', '0.4deg'];
    for (const tile of document.querySelectorAll<HTMLElement>("[data-testid='agent-tile']")) {
      const name = tile.querySelector('.hybrid-tile-branch')?.textContent ?? tile.textContent ?? '';
      tile.style.setProperty('rotate', tilts[parseInt(hash(name), 16) % tilts.length]!, 'important');
    }
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
function makeRepo(dir: string, name: string): string {
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
async function seedBoard(page: Page, dir: string): Promise<void> {
  const zones = await page.evaluate(
    async ({ web, api }) => {
      const added = async (path: string, params: NewZoneParams) => {
        const result = await window.agentBoard.zones.addFolder(path, params);
        if (result.status !== 'added') throw new Error(result.message);
        return result.zone;
      };
      return {
        web: await added(web, { x: 0, y: 0, width: 740, height: 440, color: '#4c6ef5' }),
        api: await added(api, { x: 820, y: 0, width: 640, height: 440, color: '#12b886' }),
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
  agents.push(await spawn(zones.web, 'Fix checkout flake', 30, 60));
  agents.push(await spawn(zones.web, 'Pick a cache', 370, 60));
  agents.push(await spawn(zones.web, 'Clear build output', 30, 240));
  agents.push(await spawn(zones.web, 'Resize images', 370, 240));
  agents.push(await spawn(zones.api, 'Prune old jobs', 30, 60));
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
    x: 380,
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
async function demoReady(page: Page): Promise<void> {
  const named = (name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });
  const within = { timeout: 30_000 };
  await expect(named('Fix checkout flake')).toHaveAttribute('data-state', 'idle', within);
  await expect(named('Pick a cache')).toContainText('Which database should I use, Postgres or SQLite?', within);
  await expect(named('Clear build output')).toContainText('Bash rm -rf dist', within);
  await expect(named('Prune old jobs')).toContainText('Bash rm -rf build', within);
  await expect(named('Prune old jobs').getByTestId('character')).toHaveCount(2, within);
  await expect(named('Resize images').getByTestId('character')).toHaveCount(3, within);
  await expect(named('Trace session store').getByTestId('character')).toHaveCount(3, within);
  await expect(page.getByTestId('inbox-count')).toContainText('3 need you', within);
}

test('the README screenshots: the board, an expanded tile, the session window, the inbox and Add zone', async () => {
  const { dir, env } = scratch('output');
  const github = createFakeGitHub({
    ...FAKE_GITHUB_STATE,
    repos: [
      { nameWithOwner: 'acme/storefront', description: 'The web storefront' },
      { nameWithOwner: 'acme/billing-api', description: 'Invoices and payments' },
      { nameWithOwner: 'acme/design-system', description: 'Shared components' },
    ],
  });
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, AGENT_BOARD_GH: github.gh, SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    await seedBoard(window, dir);
    await expect(tile(window)).toHaveCount(6);
    await demoReady(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'board');

    await window.getByTestId('inbox-count').click();
    await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
    const prompts = window.getByTestId('inbox-prompt');
    await expect(prompts).toHaveCount(2);
    await expect(prompts.filter({ hasText: 'rm -rf dist' })).toHaveCount(1);
    await expect(prompts.filter({ hasText: 'Its general-purpose subagent wants to use Bash' }).filter({ hasText: 'rm -rf build' })).toHaveCount(1);
    await pinRandomLooks(window);
    await shoot(window, 'inbox');
    await window.keyboard.press('Escape');

    const popover = await openAddZone(window, 'GitHub');
    await expect(popover.getByRole('option').first()).toBeVisible();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'add-zone');
    await window.keyboard.press('Escape');

    // A click opens the session window; Expand in place is the setting that opens the tile where it sits instead.
    const waiting = tile(window).filter({ hasText: 'Which database' });
    await waiting.click();
    await expect(sessionWindow(window)).toBeVisible();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomLooks(window);
    await shoot(window, 'session-window');
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    await setClickOpens(window, 'Expand in place');
    await waiting.click();
    await expect(window.getByTestId('expanded-tile')).toBeVisible();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomLooks(window);
    await shoot(window, 'expanded-tile');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: the board in the dark theme', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    // Playwright pins the page to light; the setting has the window in dark mode, as macOS would.
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    await seedBoard(window, dir);
    await expect(tile(window)).toHaveCount(6);
    await demoReady(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'board-dark');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: flows, the review doc and the chat view', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  try {
    await page.setViewportSize(VIEWPORT);
    const zone = await page.evaluate(async (path) => {
      const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 840, height: 460, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, makeRepo(dir, 'storefront'));
    const spawn = (prompt: string, x: number, y: number) =>
      page.evaluate(
        async (params) => {
          const result = await window.agentBoard.agents.spawn(params);
          if (result.status !== 'started') throw new Error(result.message);
          return result.agent;
        },
        { zoneId: zone.id, prompt, position: { x, y }, cols: 100, rows: 30 },
      );
    const planner = await spawn('Plan the checkout', 20, 60);
    const coder = await spawn('Write the code', 290, 60);
    const shipper = await spawn('Ship the release', 560, 60);
    for (const name of ['Plan the checkout', 'Write the code', 'Ship the release']) {
      await expect(tile(page).filter({ hasText: name })).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    }

    // The planner's plan waits for a Send to reach the coder; the coder hands its handover on once the pull request's checks pass.
    writeFileSync(join(planner.worktree, 'plan.md'), '# Plan\n\n1. Validate the cart.\n2. Charge the card.\n');
    writeFileSync(join(coder.worktree, 'handover.md'), '# Handover\n\nThe checkout validates the cart and charges the card.\n');
    await page.evaluate(
      async ({ a, b, c }) => {
        await window.agentBoard.flowEdges.create({ from: a, to: b, payload: 'handover', path: 'plan.md', trigger: 'manual' });
        await window.agentBoard.flowEdges.create({ from: b, to: c, payload: 'handover', path: 'handover.md', conditions: [{ kind: 'pr-checks' }] });
      },
      { a: planner.sessionId, b: coder.sessionId, c: shipper.sessionId },
    );
    await expect(page.getByTestId('flow-edge')).toHaveCount(2);

    // The coder finishes a turn, and its hand-off is held: the pull request's checks can't pass with no pull request.
    await page.evaluate((id) => window.agentBoard.agents.answer(id, 'Now open the pull request'), coder.sessionId);
    await expect(page.getByTestId('flow-edge-note')).toHaveText('held until CI green', { timeout: 30_000 });

    // A reviewer: its tile is dashed, and it ends once its review doc is in.
    const coderTile = page.locator(`[data-testid="agent-tile"][data-session-id="${coder.sessionId}"]`);
    await tileAction(coderTile, 'Review its work');
    const reviewer = page.locator('[data-testid="agent-tile"][data-reviewer]');
    await expect(reviewer).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.reviews.list()))[0]?.status).toBe('ready');
    await expect(tile(page)).toHaveCount(4);

    await page.getByRole('button', { name: 'Fit View' }).click();
    await stillBoard(page);
    const rules = page.getByRole('complementary', { name: 'Edge rules' });
    await page.getByTestId('flow-edge').filter({ hasText: 'handover.md' }).locator('.flow-edge-pill').click({ force: true });
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('Write the code');
    await expect(rules).toContainText('no pull request yet');
    await expect(rules.getByTestId('edge-rules-preview')).toContainText('The checkout validates the cart');
    await pinRandomLooks(page);
    await pinPaths(page);
    await shoot(page, 'flow-edges');
    await rules.getByRole('button', { name: 'Close edge rules' }).click();

    // The review doc is a tab of the implementer's window.
    await coderTile.getByTestId('tile-review').click();
    const win = sessionWindow(page);
    await expect(win.getByRole('tab', { name: 'Review · round 1' })).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByTestId('review-verdict')).toContainText('Changes requested');
    await pinRandomLooks(page);
    await pinPaths(page);
    await shoot(page, 'review-doc');
    await win.getByRole('button', { name: 'Close session window' }).click();

    // The chat view reads the agent's transcript.
    await coderTile.dblclick();
    await expect(win).toBeVisible();
    await win.getByRole('tab', { name: 'Terminal' }).click();
    await win.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = win.getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('Done: Now open the pull request');
    // Its tool calls fold into one row: opened, to show a call.
    await win.getByRole('button', { name: 'Expand all' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(1);
    await pinRandomLooks(page);
    await shoot(page, 'chat-view');
    expect((await agents(page)).length).toBe(4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: first-run onboarding', async () => {
  const { dir, env } = scratch('output');
  const github = createFakeGitHub();
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${fakeBinDir}:${env.PATH}`, AGENT_BOARD_GH: github.gh, AGENT_BOARD_ONBOARDING: '1', SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    await expect(window.getByRole('dialog', { name: 'Welcome to agent-board' })).toBeVisible();
    await shoot(window, 'onboarding-welcome');
    await window.getByRole('button', { name: 'Get started' }).click();
    await expect(window.getByTestId('connect-summary')).toBeVisible();
    await expect(window.getByRole('img', { name: 'Checking' })).toHaveCount(0);
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'onboarding-connect');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: Add zone from a Linear team', async () => {
  // The key goes to a throwaway keychain file, which only macOS has (as in add-zone.spec.ts).
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain: this shot is only made on a Mac');
  // A Linear that knows one invented team: every query gets the same answer, which is all the Linear tab asks for.
  const linear = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { teams: { nodes: [{ key: 'WEB', name: 'Storefront' }, { key: 'PAY', name: 'Payments' }, { key: 'DSN', name: 'Design system' }] } } }));
    });
  });
  await new Promise<void>((resolve) => linear.listen(0, '127.0.0.1', resolve));
  const keychain = createTempKeychain();
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    {
      ...env,
      ...RENDER_ENV,
      AGENT_BOARD_LINEAR_API_URL: `http://127.0.0.1:${(linear.address() as AddressInfo).port}/graphql`,
      AGENT_BOARD_KEYCHAIN: keychain.path,
      SHELL: '/bin/sh',
    },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    const popover = await openAddZone(window, 'Linear');
    await popover.getByRole('textbox', { name: 'Linear API key' }).fill('lin_api_demo0123456789');
    await popover.getByRole('button', { name: 'Connect Linear' }).click();
    await popover.getByRole('option').filter({ hasText: 'Storefront' }).click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue('Storefront');
    await shoot(window, 'add-zone-linear');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    keychain.remove();
    linear.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
