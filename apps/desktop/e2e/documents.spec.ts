import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, screen, sessionWindow, setClickOpens, spawnAgent, tile, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test, tabText } from './launch.ts';
import { scratch } from './scratch.ts';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { putDocsOnBoard, showTileParts } from './settings-helpers.ts';

// An agent shows the user a document through the board MCP: a Document tab in its window, listed with the agent, and a
// card on the board when Settings puts docs there (most tests here turn it on). The
// user edits a Markdown one there, which writes the file and tells the agent what changed. The fake claude's
// `ask-plan` scenario writes and shows the file; nothing here writes it for the agent.

const agentTile = (window: Page, agent: Agent) => tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`));
const docView = (window: Page) => sessionWindow(window).getByTestId('document-view');

async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** The agent as the daemon has it now. */
const latest = (page: Page, agent: Agent) => page.evaluate((sessionId) => window.agentBoard.agents.list().then((all) => all.find((each) => each.sessionId === sessionId)!), agent.sessionId);

async function withApp(body: (window: Page, app: ElectronApplication) => Promise<void>, { docsOnBoard = true } = {}): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env);
  try {
    await showTileParts(window, ['chips']);
    if (docsOnBoard) await putDocsOnBoard(window);
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await body(window, app);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

test('by default a document asked for on the board gets no card: it is listed with its agent, and ⌘K opens it', async () => {
  await withApp(
    async (window) => {
      const agent = await spawn(window, 'Doc on the board: docs/release-plan.md');
      await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
      await expect(window.getByTestId('doc-card')).toHaveCount(0);

      await window.keyboard.press(windowKey('k'));
      const switcher = window.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
      await switcher.getByRole('combobox').fill('Release 1.4');
      await switcher.locator('[data-testid="spotlight-row"][data-kind="document"]').click();
      await expect(docView(window).getByTestId('doc-body').getByRole('heading', { name: 'Order' })).toBeVisible();
    },
    { docsOnBoard: false },
  );
});

test('a document shown on the board is a card beside its agent; its Document tab edits the file and tells the agent the diff', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc on the board: docs/release-plan.md');

    const card = window.getByTestId('doc-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Release 1.4 plan');
    await expect(card).toContainText('release-plan.md');
    await expect(card.getByTestId('doc-card-preview')).toContainText('Merge the flake fix first');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');

    // Double-click opens it as a Document tab in the agent's window, read by default.
    await card.dispatchEvent('dblclick');
    await expect(docView(window)).toBeVisible();
    await expect(docView(window).getByTestId('doc-body').getByRole('heading', { name: 'Order' })).toBeVisible();
    await expect(docView(window).getByTestId('doc-meta')).toContainText('v1 · written by');

    // Edit splits it into its source and the live render; ⌘S writes the file and tells the agent.
    await docView(window).getByRole('button', { name: 'Edit' }).click();
    const source = docView(window).getByLabel('Markdown of Release 1.4 plan');
    await expect(source).toBeFocused();
    await source.fill('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n');
    await expect(docView(window).getByLabel('Preview')).toContainText('Hold the pin bump to 1.5.');
    await expect(docView(window).getByTestId('doc-edit-hint')).toContainText('1 change');
    await source.press('ControlOrMeta+s');

    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    await expect(docView(window).getByTestId('doc-meta')).toContainText('v2 · written by you');
    const saved = await latest(window, agent);
    expect(readFileSync(join(saved.worktree, 'docs/release-plan.md'), 'utf8')).toBe('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n');
    await expect(card).toContainText('you edited');

    // Typed at its prompt once its turn is over.
    await sessionWindow(window).getByRole('tab', { name: tabText('claude'), exact: true }).click();
    await expect(screen(window)).toContainText('The user edited docs/release-plan.md (v2)', { timeout: TURN_MS });
    await expect(screen(window)).toContainText('+ Hold the pin bump to 1.5.', { timeout: TURN_MS });

    // The card collapses to a slim bar and back, and taken off the board, the document stays the agent's.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await card.click();
    await window.getByRole('button', { name: 'Collapse to a bar' }).click();
    await expect(card).toHaveAttribute('data-collapsed', 'true');
    await expect(card.getByTestId('doc-card-preview')).toHaveCount(0);
    await window.getByRole('button', { name: 'Show the page' }).click();
    await expect(card.getByTestId('doc-card-preview')).toBeVisible();
    await window.getByRole('button', { name: 'Take it off the board' }).click();
    await expect(card).toHaveCount(0);
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await expect(docView(window)).toContainText('Release 1.4 plan');
  });
});

test('Save and ⌘S never write over a version the agent saved while the user was editing: only Keep mine does', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: plan.md');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await docView(window).getByRole('button', { name: 'Edit' }).click();
    const source = docView(window).getByLabel('Markdown of Release 1.4 plan');
    await source.fill('# Release 1.4 plan\n\nMine.\n');

    // The agent writes the file again meanwhile.
    const path = join((await latest(window, agent)).worktree, 'plan.md');
    writeFileSync(path, '# Release 1.4 plan\n\nThe agent’s new section.\n');
    const banner = docView(window).getByTestId('doc-rewritten');
    await expect(banner).toContainText(`${agent.name} saved v2 while you were editing.`);
    await expect(docView(window).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await source.press('ControlOrMeta+s');
    await expect(banner.getByRole('button', { name: 'Keep mine' })).toBeFocused();
    await expect(banner).toBeVisible();
    expect(readFileSync(path, 'utf8')).toBe('# Release 1.4 plan\n\nThe agent’s new section.\n');

    await banner.getByRole('button', { name: 'Keep mine' }).click();
    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    expect(readFileSync(path, 'utf8')).toBe('# Release 1.4 plan\n\nMine.\n');
    await sessionWindow(window).getByRole('tab', { name: tabText('claude'), exact: true }).click();
    await expect(screen(window)).toContainText('The user kept their version of plan.md over your v2', { timeout: TURN_MS });
  });
});

test('a long Markdown document reads with its contents rail, its findings fold and open, and it reopens where the reader left it, its findings still open', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: plan.md');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
    const sections = Array.from({ length: 12 }, (_, at) => `## Step ${at + 1}\n\n${'Merge it once the gate is green, then tell the team. '.repeat(12)}\n`);
    const long = ['# Release 1.4 plan', '', '## Findings', '', '1. **[blocker] The pin bump breaks the build.** It needs the new lockfile.', '2. [minor] A typo in the notes.', '', ...sections].join('\n');
    const path = join((await latest(window, agent)).worktree, 'plan.md');
    writeFileSync(path, long);
    await agentTile(window, agent).getByTestId('tile-docs').click();
    const body = docView(window).getByTestId('doc-body');
    const rail = docView(window).getByTestId('reading-rail');
    const blocker = body.locator('#read-finding-the-pin-bump-breaks-the-build');
    const minor = body.locator('#read-finding-a-typo-in-the-notes');
    await expect(body).toContainText('Step 12');
    await expect(rail).toContainText('Findings');
    await expect(docView(window).getByTestId('doc-time-left')).toHaveText(/min read$/);

    // Open all opens every finding; Fold all folds them again.
    await body.getByRole('button', { name: 'Open all' }).click();
    await expect(blocker).toHaveAttribute('open', '');
    await expect(minor).toHaveAttribute('open', '');
    await body.getByRole('button', { name: 'Fold all' }).click();
    await expect(blocker).not.toHaveAttribute('open');
    await expect(minor).not.toHaveAttribute('open');

    // ⌘F on words in a folded finding opens it.
    await body.focus();
    await window.keyboard.press('ControlOrMeta+f');
    await window.getByTestId('find-field').fill('new lockfile');
    await expect(window.getByTestId('find-count')).toHaveText('1 of 1');
    await expect(blocker).toHaveAttribute('open', '');
    await window.getByTestId('find-field').press('Escape');

    // From the end of the page, a finding's row in the rail opens it and goes to it.
    await body.evaluate((scroller) => (scroller.scrollTop = scroller.scrollHeight));
    await expect(minor).not.toBeInViewport();
    await rail.getByRole('button', { name: /A typo in the notes/ }).click();
    await expect(minor).toHaveAttribute('open', '');
    await expect(minor).toBeInViewport();

    // ⌘\ hides the rail, and shows it again.
    await body.focus();
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(rail).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(rail).toBeVisible();

    // The agent writes it again: the open findings stay open.
    writeFileSync(path, `${long}\n## Step 13\n\nOne more.\n`);
    await expect(body).toContainText('One more.');
    await expect(blocker).toHaveAttribute('open', '');
    await expect(minor).toHaveAttribute('open', '');

    // Scrolled down, the head offers the way back up.
    const top = await body.evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight / 2;
      return scroller.scrollTop;
    });
    expect(top).toBeGreaterThan(0);
    await expect(docView(window).getByRole('button', { name: 'Back to the top' })).toBeVisible();

    // Closed and opened again, it is where it was.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await expect(body).toContainText('Step 13');
    await expect.poll(() => body.evaluate((scroller) => scroller.scrollTop)).toBeCloseTo(top, -1);
    await expect(blocker).toHaveAttribute('open', '');
  });
});

test('esc leaves Edit with nothing written, and an HTML document is view-only with comments for the agent', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: notes/plan.md');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await expect(docView(window)).toBeVisible();

    await docView(window).getByRole('button', { name: 'Edit' }).click();
    const source = docView(window).getByLabel('Markdown of Release 1.4 plan');
    await source.fill('Not this.');
    // An unsaved draft keeps the window: ⌘Esc, or ⌘J then Esc from the header, goes back to the draft, not away.
    await expect(docView(window)).toHaveAttribute('data-unsaved', /"kind":"document"/);
    await window.keyboard.press(windowKey('Escape'));
    await expect(source).toBeFocused();
    await window.keyboard.press(windowKey('j'));
    await expect(sessionWindow(window).locator('.session-window-head')).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(source).toBeFocused();
    await expect(sessionWindow(window)).toBeVisible();
    await expect(source).toHaveValue('Not this.');
    await source.press('Escape');
    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    // The window stays open: the first esc was the editor's.
    await expect(sessionWindow(window)).toBeVisible();
    expect((await latest(window, agent)).docs[0]).toMatchObject({ version: 1, writtenBy: 'agent' });

    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    const page = await spawn(window, 'Doc: bench.html');
    await expect(agentTile(window, page).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, page).getByTestId('tile-docs').click();
    await expect(docView(window)).toHaveAttribute('data-format', 'html');
    await expect(docView(window).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(docView(window)).toContainText('view only');
    const comments = docView(window).getByTestId('doc-comments');
    await comments.getByLabel(`Comments on Cache benchmark for ${page.name}`).fill('Was this with WAL on?');
    await comments.getByRole('button', { name: 'Send comments' }).click();
    await expect(comments).toContainText('Sent');
    await sessionWindow(window).getByRole('tab', { name: tabText('claude'), exact: true }).click();
    await expect(screen(window)).toContainText('The user commented on bench.html (v1):', { timeout: TURN_MS });
    await expect(screen(window)).toContainText('Was this with WAL on?', { timeout: TURN_MS });
  });
});

test('Markdown in an expanded tile selects with a mouse drag and copies, and only the Edit button opens the editor', async () => {
  await withApp(async (window, app) => {
    const agent = await spawn(window, 'Doc on the board: docs/release-plan.md');
    await setClickOpens(window, 'Expand in place');
    await agentTile(window, agent).dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toBeVisible();
    // The document's card opens its tab in the tile already expanded.
    await window.getByTestId('doc-card').dispatchEvent('dblclick');
    const view = expanded.getByTestId('document-view');
    const body = view.getByTestId('doc-body');
    await expect(body.getByRole('heading', { name: 'Order' })).toBeVisible();

    // A real drag over a paragraph selects its text, and does not move the tile.
    // The text itself, not the decision card lifted from it.
    const text = body.locator('.doc-read:not(.doc-read-card)');
    const paragraph = text.getByText('Merge the flake fix first');
    await paragraph.scrollIntoViewIfNeeded();
    const tileBefore = await settledBox(expanded);
    const box = (await paragraph.boundingBox())!;
    await drag(window, { x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + box.width - 1, y: box.y + box.height / 2 });
    const selected = await window.evaluate(() => globalThis.getSelection()?.toString() ?? '');
    expect(selected).toContain('Merge the flake fix first');
    expect(await expanded.boundingBox()).toEqual(tileBefore);
    await expect(view).toHaveAttribute('data-mode', 'read');

    // ⌘C puts it on the clipboard.
    await app.evaluate(({ clipboard }) => clipboard.writeText('sentinel'));
    await window.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(selected);

    // A double-click or a click and hold on the text opens nothing; the Edit button does.
    await paragraph.dblclick({ position: { x: 4, y: 4 } });
    await body.click({ delay: 800 });
    await expect(view).toHaveAttribute('data-mode', 'read');
    await view.getByRole('button', { name: 'Edit' }).click();
    await expect(view).toHaveAttribute('data-mode', 'edit');
  });
});

test('a selected document card resizes from a side and a corner, undoes in one step, and keeps its size through the slim bar', async () => {
  await withApp(async (page) => {
    await spawn(page, 'Doc on the board: docs/long-plan.md');
    const card = page.getByTestId('doc-card');
    // How many of the preview's lines show whole inside the card, not clipped.
    const shownLines = () =>
      card.getByTestId('doc-card-preview').evaluate((body) => {
        const end = body.getBoundingClientRect().bottom;
        return [...body.querySelectorAll('li')].filter((line) => line.getBoundingClientRect().bottom <= end).length;
      });
    await expect(card.getByTestId('doc-card-preview')).toContainText('Step 14');
    const linesBefore = await shownLines();
    await expect(card).toBeVisible();
    const saved = () =>
      page.evaluate(() => window.agentBoard.items.list().then((all) => all.filter((item) => item.kind === 'document').map(({ width, height }) => [width, height])[0]));
    const [width0, height0] = (await saved())!;

    // Dragging the right side wider shows more of the page.
    await card.click();
    const side = await settledBox(page.locator('.react-flow__resize-control.line.right'));
    const from = centreOf(side);
    await drag(page, from, { x: from.x + 80, y: from.y });
    await expect.poll(saved).toEqual([width0! + 80, height0]);

    // A corner changes both; one undo step takes the corner drag back.
    const corner = centreOf(await settledBox(page.locator('.react-flow__resize-control.handle.bottom.right')));
    await drag(page, corner, { x: corner.x + 20, y: corner.y + 70 });
    await expect.poll(saved).toEqual([width0! + 100, height0! + 70]);
    // The preview fills the taller page: more of the document shows.
    await expect.poll(shownLines).toBeGreaterThan(linesBefore);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(saved).toEqual([width0! + 80, height0]);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(saved).toEqual([width0! + 100, height0! + 70]);

    // The slim bar keeps its height; showing the page again restores the user's size.
    await page.getByRole('button', { name: 'Collapse to a bar' }).click();
    await expect(card).toHaveAttribute('data-collapsed', 'true');
    await expect.poll(saved).toEqual([width0! + 100, 76]);
    await page.getByRole('button', { name: 'Show the page' }).click();
    await expect.poll(saved).toEqual([width0! + 100, height0! + 70]);
  });
});

test('⌘F in a Markdown document opens a find bar with a count; ↵ and ⇧↵ step through the matches and esc closes it', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: plan.md');
    await agentTile(window, agent).getByTestId('tile-docs').click();
    const body = docView(window).getByTestId('doc-body');
    await expect(body).toContainText('Merge the flake fix first');
    await expect(window.getByTestId('find-bar')).toHaveCount(0);

    await body.click();
    await window.keyboard.press('ControlOrMeta+f');
    const field = window.getByTestId('find-field');
    await expect(field).toBeFocused();
    await field.fill('the');
    const count = window.getByTestId('find-count');
    await expect(count).toHaveText(/^1 of [2-9]\d*$/);
    const total = ((await count.textContent()) ?? '').split(' of ')[1]!;
    await field.press('Enter');
    await expect(count).toHaveText(`2 of ${total}`);
    await field.press('Shift+Enter');
    await expect(count).toHaveText(`1 of ${total}`);
    await field.press('Shift+Enter');
    await expect(count).toHaveText(`${total} of ${total}`);
    await field.fill('zzzz');
    await expect(count).toHaveText('No matches');

    await field.press('Escape');
    await expect(window.getByTestId('find-bar')).toHaveCount(0);
    await expect(docView(window)).toBeVisible();
  });
});
