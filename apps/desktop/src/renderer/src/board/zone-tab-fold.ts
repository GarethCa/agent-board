import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useSimplified } from '../design';

/** One of a zone tab's chips that can fold into its ⋯ menu, and its width on the tab. */
export interface FoldingChip {
  key: string;
  width: number;
}

/**
 * Which of a zone tab's `chips` fold into ⋯ for the tab to fit in `room`: from the first (the least needed),
 * only as many as it takes. `rest` is the width of the rest of the tab, its name in full, and `gap` the space before
 * each chip. With every chip folded and still no fit, the name gives way, cut short with an ellipsis.
 */
export function chipsToFold(room: number, rest: number, chips: readonly FoldingChip[], gap: number): ReadonlySet<string> {
  const folded = new Set<string>();
  let width = chips.reduce((sum, chip) => sum + chip.width + gap, rest);
  for (const chip of chips) {
    if (width <= room) break;
    folded.add(chip.key);
    width -= chip.width + gap;
  }
  return folded;
}

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((key) => b.has(key));

/** What on a zone's tab gives way, cut short, once its chips have all folded: its name, and a clone's progress. */
const SHRINKS = '.zone-tab-name, .zone-clone-text';

/**
 * Folds the chips of a zone's tab into its ⋯ menu as the zone gets too narrow for them, and back as it widens.
 * `order` names the chips on the tab now, the least needed first; each is drawn in an element with `data-fold` set to
 * its key while it isn't folded. `content` changes whenever the tab's text does. The strip is the room the tab may take.
 */
export function useZoneTabFold<Key extends string>(
  order: readonly Key[],
  content: string,
): {
  stripRef: RefObject<HTMLDivElement | null>;
  tabRef: RefObject<HTMLDivElement | null>;
  folded: ReadonlySet<Key>;
} {
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<Key>>(new Set());
  // A folded chip isn't drawn, so it can't be measured: it keeps the width it had when it was last on the tab. If its
  // text changes meanwhile it may unfold a step early or late, and folds again at once when measured.
  const widths = useRef(new Map<string, number>());
  const [resized, setResized] = useState(0);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const observer = new ResizeObserver(() => setResized((count) => count + 1));
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  const orderKey = order.join(' ');
  // The Simplified design sets the chips in another font, so their widths change with it.
  const simplified = useSimplified();
  // Measured only when the zone's width, the chips, the text or the design change: never as the zone is merely dragged.
  useLayoutEffect(() => {
    const [strip, tab] = [stripRef.current, tabRef.current];
    if (strip === null || tab === null) return;
    const gap = parseFloat(getComputedStyle(tab).columnGap) || 0;
    let shown = 0;
    for (const chip of tab.querySelectorAll<HTMLElement>('[data-fold]')) {
      widths.current.set(chip.dataset.fold!, chip.offsetWidth);
      shown += chip.offsetWidth + gap;
    }
    let cut = 0;
    for (const text of tab.querySelectorAll<HTMLElement>(SHRINKS)) cut += text.scrollWidth - text.clientWidth;
    const rest = tab.offsetWidth - shown + cut;
    const chips = order.map((key) => ({ key, width: widths.current.get(key) ?? 0 }));
    const next = chipsToFold(strip.clientWidth, rest, chips, gap) as ReadonlySet<Key>;
    if (!sameKeys(next, folded)) setFolded(next);
    // `order` is read through `orderKey`, so a new array with the same chips measures nothing.
  }, [orderKey, content, folded, resized, simplified]);

  return { stripRef, tabRef, folded };
}
