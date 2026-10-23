import { useCallback, useRef, type RefCallback } from 'react';

const SPACING = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;

/**
 * A ref for a tile's text (its task, what it asks, its notice or status) that takes the room left once the tile's
 * fixed parts have theirs. The element is given that height by the tile's layout (`flex: 1 1 0` or shrinking, so its
 * own text never asks for more); this clamps the text to the whole lines that fit in it, with an ellipsis, and trims
 * the element to them so no part of the next line shows. Where not one line fits with its padding it drops it
 * (`data-tight`), and where still none fits it hides (the full text is in the tooltip). It fits again whenever the tile,
 * or any part of it, changes size: resized, or a footer that wraps.
 *
 * A `data-yields` element right after it (a byline under its text) comes second: it shows only in the room the lines
 * that fit leave over, so it never takes a line from the text.
 */
export function useFittedLines(): RefCallback<HTMLElement> {
  const observer = useRef<ResizeObserver | undefined>(undefined);
  return useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    const tile = element?.parentElement;
    if (element === null || tile === null || tile === undefined) return;
    // A padded element has its text in a child of its own: overflow clips at the padding, so a line cut off in it would
    // show in the padding below.
    const text = element.querySelector<HTMLElement>(':scope > .hybrid-tile-text') ?? element;
    /** The whole lines of text that fit, and their height; undefined before the element has a line height. */
    const measure = () => {
      const line = parseFloat(getComputedStyle(text).lineHeight);
      if (!(line > 0)) return undefined;
      const style = getComputedStyle(element);
      const spacing = SPACING.reduce((sum, side) => sum + parseFloat(style[side]), 0);
      return { line, spacing, fits: Math.floor((element.clientHeight - spacing) / line) };
    };
    const yielding = element.nextElementSibling instanceof HTMLElement && element.nextElementSibling.hasAttribute('data-yields') ? element.nextElementSibling : undefined;
    const fit = () => {
      // Without what yields, so the text is fitted in all the room there is.
      if (yielding !== undefined) yielding.style.display = 'none';
      // Back to the stylesheet's ceiling and untrimmed, so what is measured is the room the tile leaves.
      element.removeAttribute('data-tight');
      text.style.removeProperty('-webkit-line-clamp');
      text.style.maxHeight = 'none';
      element.style.maxHeight = 'none';
      let measured = measure();
      if (measured === undefined) return;
      const available = element.clientHeight;
      // The lines the whole text takes (clamp lifted), before the element is trimmed to those that fit.
      const contents = document.createRange();
      contents.selectNodeContents(text);
      const wanted = contents.getBoundingClientRect().height;
      if (measured.fits < 1) {
        element.setAttribute('data-tight', '');
        measured = measure()!;
      }
      const lines = Math.max(1, measured.fits);
      text.style.setProperty('-webkit-line-clamp', String(lines));
      text.style.maxHeight = `${lines * measured.line}px`;
      element.style.maxHeight = `${lines * measured.line + measured.spacing}px`;
      element.style.visibility = measured.fits < 1 ? 'hidden' : '';
      if (yielding === undefined) return;
      // What the lines left over, with the yielding element shown, still has to hold it.
      yielding.style.display = '';
      // The text may need fewer lines than fit: the element gives the rest up too, so the yielding one has it.
      const used = Math.min(lines, Math.max(1, Math.ceil((wanted - 1) / measured.line)));
      element.style.maxHeight = `${used * measured.line + measured.spacing}px`;
      const room = available - (used * measured.line + measured.spacing);
      if (measured.fits < 1 || room < yielding.offsetHeight) yielding.style.display = 'none';
    };
    fit();
    observer.current = new ResizeObserver(fit);
    for (const part of [tile, ...tile.children]) observer.current.observe(part);
  }, []);
}
