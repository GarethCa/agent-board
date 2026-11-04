import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, screen, showTerminalView, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { serveWebPages } from './web-server.ts';

test('an address after a line of emoji is drawn where the terminal holds it: a ⌘-click on its first and last character opens it', async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('emoji-link');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', server.url);
    await tile(window).dblclick();
    await showTerminalView(window);
    const rows = screen(window);
    await expect(rows).toContainText('⚠️', { timeout: TURN_MS });

    // Where the address is drawn, from the page's own layout of the row that holds it.
    const line = rows.locator('> div').filter({ hasText: '🚀' });
    await expect(line).toHaveCount(1);
    const drawn = await line.evaluate((row, url) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(url);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + url.length);
        const { left, right, top, height } = range.getBoundingClientRect();
        return { left, right, y: top + height / 2 };
      }
      return null;
    }, server.url);
    expect(drawn).not.toBeNull();
    const cell = (drawn!.right - drawn!.left) / server.url.length;

    const command = process.platform === 'darwin' ? 'Meta' : 'Control';
    const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((win) => win.contentView.children).length);
    for (const x of [drawn!.left + cell * 0.5, drawn!.right - cell * 0.5]) {
      await window.mouse.move(x, drawn!.y);
      await window.keyboard.down(command);
      await window.mouse.click(x, drawn!.y);
      await window.keyboard.up(command);
      await expect.poll(views).toBeGreaterThan(0);
      await window.getByRole('button', { name: `Close ${new URL(server.url).host}` }).click();
      await expect.poll(views).toBe(0);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
