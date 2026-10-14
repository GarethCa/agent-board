import { test, expect, type Page } from '@playwright/test';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withDaemon } from './board-helpers.ts';
import { connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

const GRADIENT = readFileSync(new URL('./images/gradient.png', import.meta.url));
/** The page every link card's fetch is answered with: a recorded one, so nothing here reaches the network. */
const ARTICLE = fileURLToPath(new URL('../../../packages/daemon/test/fixtures/article.html', import.meta.url));

/** The board as the daemon has stored it. */
function storedItems(dataDir: string): Promise<BoardItem[]> {
  return withDaemon(dataDir, (client) => client.call('item.list'));
}

/** Pastes `file` and/or `text` onto the board, as the paste shortcut does with the clipboard's contents. */
async function paste(window: Page, contents: { image?: { bytes: number[]; name: string; type: string }; text?: string }) {
  await window.evaluate(({ image, text }) => {
    const data = new DataTransfer();
    if (image) data.items.add(new File([new Uint8Array(image.bytes)], image.name, { type: image.type }));
    if (text) data.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, contents);
}

test('pastes an image and a link, and keeps them across a restart', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir, { AGENT_BOARD_LINK_FETCH_HTML: ARTICLE });
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
    });

    // Pasted where the pointer is.
    await window.mouse.move(300, 300);
    // An image: stored by the daemon under images/<sha256>.png, and drawn from there.
    await paste(window, { image: { bytes: [...GRADIENT], name: 'gradient.png', type: 'image/png' } });
    const image = window.getByTestId('board-image');
    await expect(image).toHaveCount(1);
    const pixels = image.locator('img');
    await expect.poll(() => pixels.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    const [stored] = await storedItems(dataDir);
    const sha = (stored!.data as { sha256: string }).sha256;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dataDir, 'images', `${sha}.png`))).toBe(true);
    expect(stored).toMatchObject({ kind: 'image', width: 240, height: 160 });

    // Pasted again, the same bytes are stored once.
    await window.mouse.move(640, 300);
    await paste(window, { image: { bytes: [...GRADIENT], name: 'again.png', type: 'image/png' } });
    await expect(image).toHaveCount(2);
    await expect.poll(async () => (await storedItems(dataDir)).length).toBe(2);

    await window.mouse.move(520, 520);
    // A file over 20 MB is refused with a toast, saying why without the error's name ("Error: …").
    await window.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(window.getByRole('alert')).toContainText('Could not add the image: the image is over 20 MB');
    await expect(image).toHaveCount(2);

    // Resizing keeps the aspect ratio: the newest image is selected (and on top); drag its corner.
    const box = (await image.last().boundingBox())!;
    const corner = window.locator('.react-flow__resize-control.handle.bottom.right').first();
    const handle = (await corner.boundingBox())!;
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle.x + 120, handle.y + 10, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(async () => {
        const newest = (await storedItems(dataDir))[1]!;
        return newest.width > 240 ? Math.round((newest.width / newest.height) * 100) / 100 : 0;
      })
      .toBe(1.5);
    expect((await image.last().boundingBox())!.width).toBeGreaterThan(box.width);

    await window.mouse.move(600, 640);
    // A link: the bare URL first, then the page's title and domain, from the recorded page.
    await paste(window, { text: 'https://www.example.com/posts/1' });
    const card = window.getByTestId('link-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('link-card-title')).toHaveText('Why boards beat terminals — a field note');
    await expect(card).toContainText('example.com');

    // Clicking it opens the URL in the browser (stubbed here).
    await card.click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(['https://www.example.com/posts/1']);

    // The picture for the PR description, when asked for.
    if (process.env.LINK_CARDS_SCREENSHOT) await window.screenshot({ path: process.env.LINK_CARDS_SCREENSHOT });

    // An http link is refused, and text that is not a URL is left alone.
    await paste(window, { text: 'http://insecure.example.org' });
    await expect(window.getByRole('alert')).toContainText('only https links');
    await paste(window, { text: 'just some words' });
    await expect(card).toHaveCount(1);

    // They are the daemon's: they survive the app and the daemon restarting.
    await app.close();
    await stopDaemon(dataDir);
    app = await launchApp(dataDir, { AGENT_BOARD_LINK_FETCH_HTML: ARTICLE });
    const reopened = await app.firstWindow();
    await connectedDaemonPid(reopened);
    await expect(reopened.getByTestId('board-image')).toHaveCount(2);
    await expect(reopened.getByTestId('link-card-title')).toHaveText('Why boards beat terminals — a field note');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test('an image file dropped on the board lands where it is dropped; other files are refused', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = window.locator('.react-flow__pane');
    await expect(pane).toBeVisible();

    /** Dispatches a dragover, then a drop, of `files` at (x, y) on the board; says whether the dragover allowed a drop. */
    const drop = (files: { bytes: number[]; name: string; type: string }[], at: { x: number; y: number }) =>
      window.evaluate(
        ({ files, at }) => {
          const data = new DataTransfer();
          for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
          const target = document.elementFromPoint(at.x, at.y)!;
          const init = { dataTransfer: data, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true };
          const over = new DragEvent('dragover', init);
          target.dispatchEvent(over);
          target.dispatchEvent(new DragEvent('drop', init));
          return over.defaultPrevented;
        },
        { files, at },
      );

    const allowed = await drop([{ bytes: [...GRADIENT], name: 'dropped.png', type: 'image/png' }], { x: 420, y: 380 });
    expect(allowed, 'dragover accepts a drop of files').toBe(true);
    const image = window.getByTestId('board-image');
    await expect(image).toHaveCount(1);
    await expect(image.locator('img')).toBeVisible();
    // Centred on the drop point.
    const box = (await image.boundingBox())!;
    expect(box.x + box.width / 2).toBeCloseTo(420, -1);
    expect(box.y + box.height / 2).toBeCloseTo(380, -1);
    expect(await storedItems(dataDir)).toMatchObject([{ kind: 'image', width: 240, height: 160 }]);

    // A file that is not an image is refused with a toast, and makes nothing.
    await drop([{ bytes: [104, 105], name: 'notes.txt', type: 'text/plain' }], { x: 700, y: 500 });
    await expect(window.getByRole('alert')).toContainText('only images');
    await expect(image).toHaveCount(1);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
