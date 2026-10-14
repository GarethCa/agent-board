import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The pinned rendering setup shared by the visual spec (baselines) and the README screenshots (docs/assets/screenshots).

/**
 * Everything that can make the same page draw different pixels, fixed. Software rendering at one pixel per CSS pixel,
 * no font hinting and no sub-pixel (LCD) text, which depend on the machine's graphics and font settings; one locale
 * and time zone, so no date or number is formatted differently.
 */
export const RENDER_ARGS = ['--disable-gpu', '--force-device-scale-factor=1', '--font-render-hinting=none', '--disable-lcd-text', '--lang=en-US'];
export const RENDER_ENV = { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Before each shot: motion off (the running characters' legs loop for ever, and a frame caught mid-swing differs by a
 * few dozen pixels), the fonts loaded, and two animation frames painted so the layout has settled.
 */
export async function settle(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/**
 * Nothing hovered, wherever the real cursor rests over the window: tiles show their actions on hover, and the gallery
 * holds its own hover states. Returns a function that gives the pointer back, for a test that clicks after its shots.
 */
export async function ignorePointer(page: Page): Promise<() => Promise<void>> {
  const style = await page.addStyleTag({ content: '* { pointer-events: none !important; }' });
  return () => style.evaluate((element) => (element as Element).remove());
}

/**
 * Pins what differs run to run in the board's text, so the shots guard it rather than hide it: a branch's random suffix
 * becomes `000000`, a worktree's path a fixed one, the daemon's build and pid fixed words. Text nodes only, so icons stay.
 */
export async function pinRandomText(page: Page) {
  await page.evaluate(() => {
    const textNodes = (element: Element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      return nodes;
    };
    for (const element of document.querySelectorAll('.hybrid-tile-branch, .session-window-where, .details-branch, .ui-section-meta')) {
      for (const node of textNodes(element)) node.data = node.data.replace(/-[0-9a-f]{6}(?=$|-review-r\d+$)/, '-000000');
    }
    for (const element of document.querySelectorAll('.details-soft')) {
      for (const node of textNodes(element)) node.data = `~/.agent-board/worktrees/${node.data.split('/').at(-1)!.replace(/-[0-9a-f]{6}$/, '-000000')}`;
    }
    for (const element of document.querySelectorAll("[data-testid='daemon-details']")) element.textContent = 'Build 0000000 · daemon 0.0.0 · pid 1000 · schema v1';
  });
}

const FONTS = [
  { family: 'Pinned Sans', file: 'DejaVuSans.woff2', weight: '100 599' },
  { family: 'Pinned Sans', file: 'DejaVuSans-Bold.woff2', weight: '600 900' },
  { family: 'Pinned Mono', file: 'DejaVuSansMono.woff2', weight: '100 900' },
].map((face) => ({ ...face, data: readFileSync(join(import.meta.dirname, 'fonts', face.file)).toString('base64') }));

/**
 * Pins the theme's fonts to ones in the repo (e2e/fonts), so text renders the same whatever fonts the machine has. It
 * only overrides tokens, so what changes is exactly what a theme could change. The faces are added from their bytes:
 * the app's Content-Security-Policy rightly refuses a font from a data: URL.
 */
export async function pinFonts(page: Page) {
  const loaded = await page.evaluate(async (faces) => {
    for (const { family, data, weight } of faces) {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      document.fonts.add(await new FontFace(family, bytes, { weight }).load());
    }
    return document.fonts.check('13px "Pinned Sans"') && document.fonts.check('13px "Pinned Mono"');
  }, FONTS);
  expect(loaded, 'the pinned fonts loaded').toBe(true);
  await page.addStyleTag({ content: ":root { --font-sans: 'Pinned Sans'; --font-mono: 'Pinned Mono'; }" });
}
