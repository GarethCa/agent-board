import { expect } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

// A ticket's tile opened, its own board and a new review read in place, in each design and theme.
const DESIGNS = [
  { design: 'classic', opened: 'ticket-open', zoomed: 'ticket-board', read: 'ticket-open-read' },
  { design: 'simplified', opened: 'simplified-ticket-open', zoomed: 'simplified-ticket-board', read: 'simplified-ticket-open-read' },
] as const;

// A ticket's tile at rest, needing the user, ready to merge and merged, in each design and theme, the glance designs
// (which Settings picks over either look) too: one shot of the four.
const TILE_SHOTS = [
  { design: 'classic', prefix: 'ticket-tiles', tileDesign: undefined },
  { design: 'simplified', prefix: 'simplified-ticket-tiles', tileDesign: undefined },
  { design: 'classic', prefix: 'porthole-ticket-tiles', tileDesign: 'porthole' },
  { design: 'classic', prefix: 'shelf-ticket-tiles', tileDesign: 'shelf' },
] as const;

for (const { design, prefix, tileDesign } of TILE_SHOTS) {
  for (const { theme, suffix } of THEMES) {
    test(`a ticket's tile: its chat's agent tile with its ticket in its about line and one ask, at rest, needing you, ready to merge and merged, ${tileDesign ?? design}, ${theme}`, async () => {
      needsBaselines(`${prefix}${suffix}`);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        if (tileDesign !== undefined) {
          await window.evaluate((picked) => {
            localStorage.setItem('agent-board.tile-design', picked);
            location.reload();
          }, tileDesign);
          await expect(window.getByTestId('ticket-tile-merged').locator(`[data-tile-design="${tileDesign}"]`).first()).toBeVisible();
        }
        const gallery = window.getByTestId('ticket-tile-gallery');
        // Each design draws a ticket as its chat's agent tile, a helper's ask rolled up on it: who asks and what, in a line
        // that keeps its room, and a button that answers that helper.
        await expect(gallery.locator('[data-ticket-tile]')).toHaveCount(4);
        const needsYou = window.getByTestId('ticket-tile-needs-you');
        // Classic's own tile, not a glance design drawn over it.
        const classic = design === 'classic' && tileDesign === undefined;
        if (classic) {
          await expect(needsYou.getByTestId('tile-act')).toHaveText('Answer');
          // Needing you, its title keeps at least half its head beside the buttons, on one line.
          const head = await needsYou.locator('.hybrid-tile-head').boundingBox();
          const title = await needsYou.locator('.hybrid-tile-head .hybrid-tile-name').boundingBox();
          expect(title!.width).toBeGreaterThanOrEqual(head!.width / 2);
          // Ready to merge stands up; only the merged one lies flat.
          await expect(window.getByTestId('ticket-tile-ready-to-merge').getByTestId('tile-act')).toHaveText('Merge');
          await expect(window.getByTestId('ticket-tile-ready-to-merge').getByTestId('agent-tile')).not.toHaveAttribute('data-flat');
          await expect(window.getByTestId('ticket-tile-merged').getByTestId('agent-tile')).toHaveAttribute('data-flat', 'true');
        }
        // Every design rolls up the ticket's own ask in Classic's words and button: Ready to merge with Merge, and a
        // merged Done; neither reads as needing the user.
        const merge = window.getByTestId('ticket-tile-ready-to-merge');
        await expect(merge).toContainText('Ready to merge');
        await expect(merge.getByTestId('tile-act')).toHaveText('Merge');
        await expect(merge).not.toContainText('Needs you');
        const merged = window.getByTestId('ticket-tile-merged');
        await expect(merged).toContainText('Done');
        await expect(merged).toContainText('Merged as #645.');
        await expect(merged).not.toContainText('Needs you');
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        // As shot: the line naming who asks shows whole above its footer, which keeps its button on the state's row.
        const asks = needsYou.getByText(/Its builder asks: /);
        await expect(asks).toBeVisible();
        if (classic) {
          const line = (await asks.boundingBox())!;
          const mark = (await needsYou.getByTestId('tile-mark').boundingBox())!;
          const act = (await needsYou.getByTestId('tile-act').boundingBox())!;
          expect(line.y + line.height).toBeLessThanOrEqual(mark.y);
          expect(Math.abs(act.y + act.height / 2 - (mark.y + mark.height / 2))).toBeLessThan(mark.height / 2);
        }
        await expect.soft(gallery).toHaveScreenshot(`${prefix}${suffix}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

for (const { design, opened, zoomed, read } of DESIGNS) {
  for (const { theme, suffix } of THEMES) {
    test(`a ticket's tile opened: its terminal over a strip of helpers, and its card opened with a column of them, each showing a helper, ${design}, ${theme}`, async () => {
      needsBaselines(`${opened}${suffix}`);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('ticket-open-gallery');
        const terminal = window.getByTestId('ticket-open-terminal');
        const card = window.getByTestId('ticket-open-card');
        await expect(terminal.getByTestId('expanded-tile')).toHaveAttribute('data-ticket-open', 'terminal');
        await expect(card.getByTestId('expanded-tile')).toHaveAttribute('data-ticket-open', 'card');
        // Each shows a helper in place of its chat, a breadcrumb leading back, and that helper's card marked open.
        await expect(terminal.getByTestId('ticket-crumb')).toContainText('Builder');
        await expect(card.getByTestId('ticket-crumb')).toContainText('Reviewer');
        await expect(terminal.locator('[data-testid="ticket-helper-card"][data-open]')).toHaveCount(1);
        await expect(card.locator('[data-testid="ticket-helper-card"][data-open]')).toContainText('Showing on the left');
        await expect(terminal.getByTestId('ticket-view-switch').locator('[aria-pressed="true"]')).toHaveAttribute('data-view', 'terminal');
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        await expect.soft(gallery).toHaveScreenshot(`${opened}${suffix}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
    test(`a ticket's own board, zoomed into: its chat with a box to message it and its one button, its helpers as tiles, a note, the breadcrumb and its watches' news, ${design}, ${theme}`, async () => {
      needsBaselines(`${zoomed}${suffix}`);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('ticket-board-gallery');
        await gallery.scrollIntoViewIfNeeded();
        await expect(gallery.getByTestId('ticket-board-crumb')).toContainText('ACME-726');
        await expect(gallery.getByTestId('ticket-board-watches').getByTestId('ticket-watch-icon')).toHaveCount(2);
        await expect(gallery.getByTestId('ticket-board-chat').getByTestId('ticket-board-open')).toHaveText('Open');
        await expect(gallery.getByTestId('ticket-board-chat').getByRole('textbox', { name: 'Message to the agent' })).toHaveAttribute('placeholder', 'Message the ticket…');
        await expect(gallery.getByTestId('ticket-board-helper')).toHaveCount(3);
        await expect(gallery.getByText('sam: make the dot 8 px on dark.')).toBeVisible();
        // The minimap is always on a still board: shot once it draws the chat, the three helpers and the note.
        await expect(gallery.locator('.board-minimap .react-flow__minimap-node')).toHaveCount(5);
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        await expect.soft(gallery).toHaveScreenshot(`${zoomed}${suffix}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
    test(`a ticket's card opened in place with a new review: Read, its one ask, in its footer, ${design}, ${theme}`, async () => {
      needsBaselines(`${read}${suffix}`);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('ticket-open-read-gallery');
        await gallery.scrollIntoViewIfNeeded();
        await expect(gallery.getByTestId('expanded-tile')).toHaveAttribute('data-ticket-open', 'card');
        await expect(gallery.getByTestId('tile-state-word')).toHaveText('New review');
        await expect(gallery.getByTestId('tile-act')).toHaveText('Read');
        await expect(gallery.locator('[data-testid="ticket-watch-icon"][data-kind="reviews"]')).toHaveAttribute('data-tone', 'new');
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        await expect.soft(gallery).toHaveScreenshot(`${read}${suffix}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

for (const { theme, suffix } of THEMES) {
  test(`a ticket pop-up's one row of tabs: its Board, its chat underlined as the tab it came from, its helpers, the one that asks amber, the reviewer on with its ⋯; and the row folded into "+n", ${theme}`, async () => {
    needsBaselines(`ticket-popup-row${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      const gallery = window.getByTestId('ticket-popup-row-gallery');
      await gallery.scrollIntoViewIfNeeded();
      const wide = gallery.getByTestId('ticket-popup-row-wide');
      const narrow = gallery.getByTestId('ticket-popup-row-narrow');
      const tab = (row: typeof wide, key: string) => row.locator(`[data-testid="session-tab"][data-tab="${key}"]`);
      await expect(wide.getByTestId('session-tab')).toHaveCount(5);
      await expect(tab(wide, 'ticket-you-review')).toHaveAttribute('data-active', 'true');
      await expect(tab(wide, 'ticket-you-review').getByTestId('agent-popup-tab-more')).toBeVisible();
      await expect(tab(wide, 'ticket-you')).toHaveAttribute('data-from', 'true');
      await expect(tab(wide, 'ticket-you-build')).toHaveAttribute('data-ask', 'true');
      await expect(wide.getByTestId('agent-popup-more')).toHaveCount(0);
      // Folded from the right: the Board, the tab that's on and the amber one stay, and none is clipped.
      await expect(narrow.getByTestId('agent-popup-more')).toHaveText(/^\+\d/);
      await expect(tab(narrow, 'board')).toBeVisible();
      await expect(tab(narrow, 'ticket-you-review')).toBeVisible();
      await expect(tab(narrow, 'ticket-you-build')).toBeVisible();
      expect(await narrow.locator('.session-tabs-list').evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(gallery).toHaveScreenshot(`ticket-popup-row${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
