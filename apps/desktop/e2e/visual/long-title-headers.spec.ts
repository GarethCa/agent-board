import { expect, type Locator } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, openSubmenu, spawnAgent, tile, TURN_MS } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, THEMES, needsBaselines } from './shared.ts';

/** Where the frost behind a pop-up is kept, as Settings › Appearance sets it. */
const FROST_KEY = 'agent-board.popup-frost';

test.use({ viewport: null });

const LONG_NAME = 'Make the checkout retry wait for the payment provider webhook before it marks an order as failed and emails the customer';

/** The buttons in `head` that stand past `frame`'s edges, by name: none may. */
async function outside(head: Locator, frame: Locator): Promise<string[]> {
  const edge = (await frame.boundingBox())!;
  const found: string[] = [];
  for (const button of await head.getByRole('button').all()) {
    if (!(await button.isVisible())) continue;
    const box = (await button.boundingBox())!;
    if (box.x < edge.x - 0.5 || box.x + box.width > edge.x + edge.width + 0.5) found.push((await button.getAttribute('aria-label')) ?? (await button.innerText()));
  }
  return found;
}

// An agent with a very long name, pinned expanded and then in its pop-up, in both designs, light and dark: the name
// ellipsises, with its whole text on hover, and every button keeps to the header at its size. The pop-up is as wide
// as the board less its small margin, no taller than 16:10, over the board frosted, dimmed, or dimmed deeper with reduced
// transparency. Dragged smaller by a corner it keeps its new size for the next pop-up, and a double-click fits it again.
for (const design of ['classic', 'simplified'] as const) for (const { theme, suffix: dark } of THEMES) {
  const suffix = `${design === 'simplified' ? '-simplified' : ''}${dark}`;
  test(`a long name keeps the expanded tile's and the pop-up's buttons inside them, ${design}, ${theme}`, async () => {
    test.setTimeout(150_000);
    needsBaselines(`long-title-expanded-header${suffix}`, `long-title-popup-header${suffix}`, `popup-frost${suffix}`, `popup-dim${suffix}`, `popup-frost-reduced-transparency${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, AGENT_BOARD_CLICK_OPENS: '', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
      design === 'simplified' ? { design } : {},
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix checkout flake', { name: LONG_NAME });
      await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

      await tile(window).hover();
      await tile(window).getByRole('button', { name: 'More' }).click();
      const group = await openSubmenu(window, design === 'simplified' ? 'Arrange' : 'Board');
      await group.getByRole('menuitem', { name: /^Pin expanded/ }).click();
      const expanded = window.getByTestId('expanded-tile');
      await expect(expanded).toHaveAttribute('data-pinned', 'true');
      const expandedHead = expanded.locator('.expanded-tile-head');
      await expect(expandedHead.locator('.session-window-name')).toHaveAttribute('title', new RegExp(`^${LONG_NAME}`));
      await expandedHead.hover();
      expect(await outside(expandedHead, expanded)).toEqual([]);
      await window.mouse.move(4, 4);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(expandedHead).toHaveScreenshot(`long-title-expanded-header${suffix}.png`, SHOT);
      await restorePointer();

      await expandedHead.locator('.session-window-head-fill').dblclick({ force: true });
      const popup = window.getByTestId('agent-popup');
      await expect(popup).toBeVisible();
      // It opens from a touch smaller: shoot and measure it once it has settled.
      await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const popupHead = popup.locator('.agent-popup-head');
      await expect(popupHead.locator('.session-window-name')).toHaveAttribute('title', new RegExp(`^${LONG_NAME}`));
      expect(await outside(popupHead, popup)).toEqual([]);
      await settle(window);
      await expect.soft(popupHead).toHaveScreenshot(`long-title-popup-header${suffix}.png`, SHOT);

      // Its size: as wide as the board less 16px each side, as tall as that or 16:10, centred on it.
      const scrim = window.getByTestId('agent-popup-scrim');
      const board = (await scrim.boundingBox())!;
      const client = await scrim.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
      const box = (await popup.boundingBox())!;
      const fit = { width: board.width - 32, height: Math.min(board.height - 32, (board.width - 32) / 1.6) };
      const seen = JSON.stringify({ board, client, box, fit });
      console.log(`pop-up fit ${suffix || '-classic'}: ${seen}`);
      const centred = (at: { x: number; y: number; width: number; height: number }) => {
        expect(Math.abs(at.x + at.width / 2 - (board.x + board.width / 2)), seen).toBeLessThanOrEqual(1);
        expect(Math.abs(at.y + at.height / 2 - (board.y + board.height / 2)), seen).toBeLessThanOrEqual(1);
      };
      expect(Math.abs(box.width - fit.width), seen).toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - fit.height), seen).toBeLessThanOrEqual(1);
      centred(box);

      // Dragged in by its bottom-right corner, it shrinks by twice the drag each way, staying centred, and every pop-up
      // keeps that size.
      const SIZE_KEY = 'agent-board.popup-size';
      const kept = () => window.evaluate((key) => localStorage.getItem(key), SIZE_KEY);
      const corner = (await window.getByTestId('agent-popup-edge-se').boundingBox())!;
      const [x, y] = [corner.x + corner.width / 2, corner.y + corner.height / 2];
      await window.mouse.move(x, y);
      await window.mouse.down();
      await window.mouse.move(x - 20, y - 10, { steps: 2 });
      await window.mouse.move(x - 240, y - 150, { steps: 6 });
      await window.mouse.up();
      const dragged = (await popup.boundingBox())!;
      expect(Math.abs(dragged.width - (box.width - 480))).toBeLessThanOrEqual(1);
      expect(Math.abs(dragged.height - (box.height - 300))).toBeLessThanOrEqual(1);
      centred(dragged);
      expect(JSON.parse((await kept())!)).toEqual({ width: Math.round(dragged.width), height: Math.round(dragged.height) });
      await window.mouse.move(4, 4);
      await scrim.click({ position: { x: 5, y: 5 } });
      await expect(popup).toBeHidden();
      await expandedHead.locator('.session-window-head-fill').dblclick({ force: true });
      await expect(popup).toBeVisible();
      await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const reopened = (await popup.boundingBox())!;
      expect(Math.abs(reopened.width - dragged.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(reopened.height - dragged.height)).toBeLessThanOrEqual(1);
      await window.mouse.move(4, 4);
      await settle(window);

      // The board behind it, round the pop-up at that smaller size: frosted by default, only dimmed with the switch off,
      // and with reduced transparency asked for, dimmed deeper with no blur. The pop-up's session is masked: only what is
      // round it is the point here.
      const whole = { ...SHOT, mask: [popup] };
      await expect(scrim).toHaveAttribute('data-frost', 'true');
      await expect(scrim).toHaveCSS('backdrop-filter', /blur/);
      await expect.soft(window).toHaveScreenshot(`popup-frost${suffix}.png`, whole);
      const setFrost = (on: boolean) =>
        window.evaluate(
          ([key, value]) => {
            if (value === null) localStorage.removeItem(key!);
            else localStorage.setItem(key!, value);
            globalThis.dispatchEvent(new StorageEvent('storage', { key }));
          },
          [FROST_KEY, on ? null : 'off'] as const,
        );
      await setFrost(false);
      await expect(scrim).not.toHaveAttribute('data-frost');
      await expect(scrim).toHaveCSS('backdrop-filter', 'none');
      await settle(window);
      await expect.soft(window).toHaveScreenshot(`popup-dim${suffix}.png`, whole);
      await setFrost(true);
      const cdp = await window.context().newCDPSession(window);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      await expect(scrim).toHaveAttribute('data-frost', 'true');
      await expect(scrim).toHaveCSS('backdrop-filter', 'none');
      await settle(window);
      await expect.soft(window).toHaveScreenshot(`popup-frost-reduced-transparency${suffix}.png`, whole);
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });

      // A double-click on an edge gives its default size back and forgets the size.
      await window.getByTestId('agent-popup-edge-e').dblclick();
      const refit = (await popup.boundingBox())!;
      expect(Math.abs(refit.width - box.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(refit.height - box.height)).toBeLessThanOrEqual(1);
      expect(await kept()).toBeNull();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
