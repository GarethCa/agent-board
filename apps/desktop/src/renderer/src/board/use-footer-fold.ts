import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from 'react';
import { FOOTER_LINES, foldCount, type FooterItem } from './tile-footer';

/**
 * Keeps a tile's footer to its one line (`FOOTER_LINES`): the lowest-ranked badges fold into the "+N" chip, which is the child
 * with `data-folded-chip` (always drawn, so it can be measured; hidden while nothing is folded). `badges` is how many
 * leading children are badges and `ranking` their indexes in the order they fold (see `foldRanking`); `plusShown` is
 * whether pull requests past the second are in the chip already. It measures with every child showing, then hides the
 * folded ones with `data-folded`, before the browser paints, so nothing flickers. It measures again whenever `key`
 * (what the footer says) or the footer's width changes, and returns how many badges folded.
 */
export function useFooterFold({ key, badges, ranking, plusShown }: { key: string; badges: number; ranking: number[]; plusShown: boolean }): { ref: RefCallback<HTMLElement>; folded: number } {
  const footer = useRef<HTMLElement | null>(null);
  const latest = useRef({ badges, ranking, plusShown });
  latest.current = { badges, ranking, plusShown };
  const [folded, setFolded] = useState(0);

  const fold = useCallback(() => {
    const element = footer.current;
    if (element === null) return;
    const { badges, ranking, plusShown } = latest.current;
    const children = [...element.children] as HTMLElement[];
    // Everything showing, so each child has its own width.
    for (const child of children) child.removeAttribute('data-folded');
    const items: FooterItem[] = children.map((child, index) => {
      const width = child.offsetWidth;
      if (child.hasAttribute('data-folded-chip')) return { kind: 'plus', width };
      const rank = index < badges ? ranking.indexOf(index) : -1;
      return rank >= 0 ? { kind: 'badge', width, rank } : { kind: 'fixed', width };
    });
    const count = foldCount({ items, available: element.clientWidth, gap: parseFloat(getComputedStyle(element).columnGap) || 0, maxLines: FOOTER_LINES, plusShown });
    for (const index of ranking.slice(0, count)) children[index]?.setAttribute('data-folded', '');
    if (count === 0 && !plusShown) element.querySelector('[data-folded-chip]')?.setAttribute('data-folded', '');
    setFolded(count);
  }, []);

  // Not on the width alone: a badge's text or the state pill changing can need another line.
  useLayoutEffect(fold, [fold, key]);
  const ref = useCallback<RefCallback<HTMLElement>>(
    (element) => {
      footer.current = element;
      if (element === null) return;
      let width = element.clientWidth;
      const observer = new ResizeObserver(() => {
        if (element.clientWidth === width) return;
        width = element.clientWidth;
        fold();
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    [fold],
  );
  return { ref, folded };
}
