import { expect, type Page } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

/**
 * What in each box of the long-text gallery breaks the long-text rules:
 * - Shows past the box's edge: each element's rect, cut by the ancestors that clip it, against the box's. Text that runs
 *   out of its box, or pushes a neighbour out, shows here. A subagent perched on its tile stands over the tile's edge on
 *   purpose, and an icon's drawing is not text: neither counts.
 * - Scrolls sideways.
 * - A line of text cut short with no ellipsis, or with one but nothing that shows it whole on hover (a title or a label
 *   on it or round it). An inline run cut by the line it sits in has that line's ellipsis.
 * - Text that paints past the box, though its element fits, and a line of text cut through: more than a little of it
 *   hidden, but not all (a line clamped away whole is fine). A line cut by what scrolls up and down is one scroll away,
 *   and a shape is a drawing its maker sizes: its text stops at its outline, and its editor shows it whole.
 * - In a panel, anything out of sight below: the panel's box is as tall as all it shows, so nothing in it may scroll up
 *   and down with more than it shows, the box included.
 * Text kept for screen readers is hidden on purpose.
 */
/** What scrolls sideways by design: a strip of the zones, as many as there are. What it cuts is a scroll away. */
const SIDEWAYS = '.zone-jump-track';

function spills(window: Page) {
  return window.getByTestId('long-text-gallery').evaluate((gallery, SIDEWAYS) => {
    const found: string[] = [];
    for (const box of gallery.querySelectorAll<HTMLElement>('[data-testid="long-text-box"]')) {
      const edge = box.getBoundingClientRect();
      const named = (each: Element) => `${box.firstElementChild?.getAttribute('class') ?? ''} > ${each.tagName.toLowerCase()}.${each.getAttribute('class') ?? ''}`;
      if (box.matches('.long-text-panel')) {
        for (const each of [box, ...box.querySelectorAll<HTMLElement>('*')]) {
          if (each.scrollHeight > each.clientHeight + 1 && each.clientHeight > 0 && (each === box || ['auto', 'scroll'].includes(getComputedStyle(each).overflowY))) {
            if (each !== box && each.closest('.visually-hidden') !== null) continue;
            found.push(`${named(each)}: ${each.scrollHeight - each.clientHeight}px out of sight below`);
          }
        }
      }
      for (const each of box.querySelectorAll('*')) {
        if (!(each instanceof HTMLElement) || each.closest('.subagent-perch, .visually-hidden')) continue;
        const rect = each.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(each);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && each.scrollWidth > each.clientWidth + 1 && !each.matches(SIDEWAYS)) {
          const furthest = [...each.querySelectorAll('*')].reduce<Element | null>((most, one) => (most === null || one.getBoundingClientRect().right > most.getBoundingClientRect().right ? one : most), null);
          found.push(`${named(each)}: scrolls sideways${furthest === null ? '' : `, furthest ${named(furthest)}`}`);
        }
        // What shows of it: its rect cut by each ancestor that clips.
        const clipsBy: DOMRect[] = [];
        // What scrolls up and down: a line it cuts through is one scroll away.
        const scrollsBy: DOMRect[] = [];
        let clipper: CSSStyleDeclaration | null = null;
        let sideways = false;
        for (let up = each.parentElement; up && up !== box; up = up.parentElement) {
          const clips = getComputedStyle(up);
          if (clips.overflowX === 'visible' && clips.overflowY === 'visible' && clips.clipPath === 'none') continue;
          clipper ??= clips;
          clipsBy.push(up.getBoundingClientRect());
          if (clips.overflowY === 'auto' || clips.overflowY === 'scroll') scrollsBy.push(up.getBoundingClientRect());
          if (up.matches(SIDEWAYS)) sideways = true;
        }
        const shown = (from: DOMRect, by: DOMRect[]) => ({
          left: Math.max(from.left, ...by.map((clip) => clip.left)),
          right: Math.min(from.right, ...by.map((clip) => clip.right)),
          top: Math.max(from.top, ...by.map((clip) => clip.top)),
          bottom: Math.min(from.bottom, ...by.map((clip) => clip.bottom)),
        });
        const { left, right, top, bottom } = shown(rect, clipsBy);
        if (right <= left || bottom <= top) continue;
        const past = Math.max(edge.left - left, right - edge.right, edge.top - top, bottom - edge.bottom);
        if (past > 1) found.push(`${named(each)}: ${Math.round(past)}px`);
        // Its own text, line by line, as it paints (which can be past its rect), cut by what clips it, itself too.
        const ownTexts = [...each.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
        const textClips = style.overflowX === 'visible' && style.overflowY === 'visible' ? clipsBy : [rect, ...clipsBy];
        const lines = ownTexts.flatMap((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return [...range.getClientRects()];
        });
        let textPast = 0;
        let cutThrough = '';
        for (const line of lines) {
          const seen = shown(line, textClips);
          if (seen.right <= seen.left || seen.bottom <= seen.top) continue;
          textPast = Math.max(textPast, edge.left - seen.left, seen.right - edge.right, edge.top - seen.top, seen.bottom - edge.bottom);
          // Most of a line hidden, but not all of it: cut through the middle.
          const scrolled = each.closest('.shape-label') !== null || scrollsBy.some((by) => line.top < by.top - 1 || line.bottom > by.bottom + 1);
          if (!scrolled && seen.bottom - seen.top < line.height * 0.6) cutThrough = `${Math.round(seen.bottom - seen.top)} of ${Math.round(line.height)}px shown`;
        }
        if (textPast > 2) found.push(`${named(each)}: its text ${Math.round(textPast)}px`);
        if (cutThrough !== '') found.push(`${named(each)}: a line cut through, ${cutThrough}`);
        // A line of its own text, cut short: by itself (ending in an ellipsis, or not), or by an ancestor (never one).
        if (ownTexts.length === 0 || style.whiteSpace !== 'nowrap') continue;
        const cutAcross = left - rect.left > 1 || rect.right - right > 1;
        // An inline run in a line that ends in an ellipsis is cut by that line, which draws the ellipsis.
        const lineEllipsis = cutAcross && style.display === 'inline' && clipper?.textOverflow === 'ellipsis' && clipper.whiteSpace === 'nowrap';
        const cutBySelf = lineEllipsis || (style.overflowX !== 'visible' && each.scrollWidth > each.clientWidth + 1);
        const cutByAncestor = cutAcross && !lineEllipsis && !sideways;
        if (cutByAncestor || (cutBySelf && !lineEllipsis && style.textOverflow !== 'ellipsis')) found.push(`${named(each)}: cut short with no ellipsis`);
        else if (cutBySelf) {
          const hover = each.closest('[title]:not([title=""]), [aria-label]:not([aria-label=""])');
          if (hover === null || !box.contains(hover)) found.push(`${named(each)}: cut short with nothing to show it whole on hover`);
        }
      }
    }
    return found;
  }, SIDEWAYS);
}

/**
 * The long-text galleries: board items; the panels (an agent's sidebar, the inbox, the Captain's panel, the zone bar); and
 * menus, ⌘K's rows, dialogs and Settings' controls.
 * The panels gallery is too tall for one shot under the release's 1 MB file limit, so each of its panels is shot alone:
 * `panels` of them, numbered in the gallery's order.
 */
const GALLERIES = [
  { hash: '#gallery-long-text', name: 'long-text-gallery', what: 'every board item', panels: 0 },
  { hash: '#gallery-long-text-panels', name: 'long-text-panels', what: 'every panel', panels: 9 },
  { hash: '#gallery-long-text-menus', name: 'long-text-menus', what: 'every menu and dialog', panels: 0 },
] as const;

/** A shot's baseline names: the whole gallery's, or one per panel. */
const shotsOf = (name: string, panels: number, rest: string): string[] =>
  panels === 0 ? [`${name}${rest}`] : Array.from({ length: panels }, (_, at) => `${name}-${at + 1}${rest}`);

// Very long text in every field: no text runs past its box, light and dark, under both designs.
for (const { hash, name, what, panels } of GALLERIES) for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shots = shotsOf(name, panels, `${design === 'simplified' ? '-simplified' : ''}${suffix}`);
    test(`long text keeps to its box on ${what}, ${design}, ${theme}`, async () => {
      needsBaselines(...shots);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {}, hash);
      try {
        const gallery = window.getByTestId('long-text-gallery');
        await expect(gallery).toBeVisible();
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        expect.soft(await spills(window)).toEqual([]);
        if (panels === 0) {
          await expect.soft(gallery).toHaveScreenshot(`${shots[0]}.png`, SHOT);
        } else {
          const each = gallery.locator('.long-text-gallery-row > *');
          await expect(each).toHaveCount(panels);
          for (const [at, shot] of shots.entries()) await expect.soft(each.nth(at)).toHaveScreenshot(`${shot}.png`, SHOT);
        }
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}
