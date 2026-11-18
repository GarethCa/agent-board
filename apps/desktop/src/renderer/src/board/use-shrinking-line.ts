import { useCallback, useRef, type RefCallback } from 'react';

/** A step's text size and line height, as the tokens that hold them, so each design gets its own sizes. */
export type LineStep = readonly [size: string, lineHeight: string];

/**
 * The sizes a glance tile's line tries in turn, largest first, in its fixed box (`--glance-line-box`): three lines at
 * body size, then four at each smaller step. A command it asks to run is in mono, a step smaller throughout. A step
 * drawn at the size of the one before is never taken (in a design whose small sizes are one). The last is for a wide
 * font: in the app's own, a line at the cap fits a step before it.
 */
export const LINE_STEPS: Record<'sans' | 'command', readonly LineStep[]> = {
  sans: [
    ['--font-size-md', '--space-4-5'],
    ['--font-size-sm', '--glance-line-tight'],
    ['--font-size-xs', '--glance-line-tight'],
    ['--font-size-2xs', '--glance-line-tight'],
  ],
  command: [
    ['--font-size-sm', '--glance-line-tight'],
    ['--font-size-xs', '--glance-line-tight'],
    ['--font-size-badge', '--glance-line-tight'],
  ],
};

/** What a step measures once applied: its text size and line height as drawn, and the height the whole text takes. */
export interface LineMeasure {
  fontSize: string;
  lineHeight: number;
  textHeight: number;
}

/** The step a line is drawn at, and the lines it is clamped to when the whole text fits at none. */
export type LineFit = { step: number; clamp?: number };

/**
 * The first step at which the whole text fits a box `box` px tall. A step drawn at the same size as the one before is
 * skipped (in a design whose two smallest sizes are one). Lines are counted whole, so a small size whose last line
 * overhangs its box by a pixel still counts as fitting. Past the last step it stays at the last and clamps to the lines
 * that fit.
 */
export function fitLine(box: number, steps: number, measureAt: (step: number) => LineMeasure): LineFit {
  let last: { step: number; measure: LineMeasure } | undefined;
  for (let step = 0; step < steps; step++) {
    const measure = measureAt(step);
    if (last !== undefined && measure.fontSize === last.measure.fontSize) continue;
    last = { step, measure };
    if (!(measure.lineHeight > 0)) return { step };
    if (Math.round(measure.textHeight / measure.lineHeight) <= Math.floor(box / measure.lineHeight)) return { step };
  }
  if (last === undefined) return { step: 0 };
  return { step: last.step, clamp: Math.max(1, Math.floor(box / last.measure.lineHeight)) };
}

/**
 * A ref for a glance tile's line (what it is doing, asks or was told) in its fixed box: it draws the line at the first
 * of `LINE_STEPS` at which the whole of it fits, and past the last clamps it to the lines that fit with an ellipsis
 * (`data-over`; the full text is in its tooltip). It fits again when the box changes size, when the fonts load, when
 * the text changes, and when the page's styles change (a design, theme or font swapped without resizing the box).
 */
export function useShrinkingLine(): RefCallback<HTMLElement> {
  const watchers = useRef<(() => void) | undefined>(undefined);
  return useCallback((element: HTMLElement | null) => {
    watchers.current?.();
    watchers.current = undefined;
    if (element === null) return;
    const fit = () => {
      const steps = LINE_STEPS[element.hasAttribute('data-command') ? 'command' : 'sans'];
      element.removeAttribute('data-over');
      element.style.removeProperty('-webkit-line-clamp');
      const box = element.clientHeight;
      if (!(box > 0)) return;
      const draw = (at: number) => {
        const [size, line] = steps[at]!;
        element.style.fontSize = `var(${size})`;
        element.style.lineHeight = `var(${line})`;
        element.dataset.step = String(at + 1);
      };
      const { step, clamp } = fitLine(box, steps.length, (at) => {
        draw(at);
        const style = getComputedStyle(element);
        return { fontSize: style.fontSize, lineHeight: parseFloat(style.lineHeight), textHeight: element.scrollHeight };
      });
      // A step skipped for its size may have been drawn last.
      draw(step);
      if (clamp === undefined) return;
      element.setAttribute('data-over', '');
      element.style.setProperty('-webkit-line-clamp', String(clamp));
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(element);
    const changed = new MutationObserver(fit);
    changed.observe(element, { childList: true, characterData: true, subtree: true, attributeFilter: ['data-command'] });
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) fit();
    });
    // A new style sheet, a design or theme set on the root, or a font loaded later changes its sizes, not its box. Not
    // on a frame: a hidden window draws none.
    const restyled = new MutationObserver(fit);
    restyled.observe(document.documentElement, { attributes: true });
    restyled.observe(document.head, { childList: true });
    document.fonts?.addEventListener('loadingdone', fit);
    watchers.current = () => {
      live = false;
      resized.disconnect();
      changed.disconnect();
      restyled.disconnect();
      document.fonts?.removeEventListener('loadingdone', fit);
    };
  }, []);
}
