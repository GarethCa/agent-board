/**
 * A line cut short on a memory, a queue or a steps card shows whole while it is pointed at or focused: its full text
 * is laid over it, wrapped to its width, so no row under it moves. The overlay sits in the card's own node, so it
 * pans and zooms with the board and no list's edge clips it. A selected card wraps its lines in place instead
 * (app.css), so nothing there is cut short.
 */

/** The cells that cut a long line short with an ellipsis: the text itself, not the icon before it, so none moves. */
const CUT_CELLS = [
  '.listcard-rows :is(.listcard-value, .memory-key-name, .memory-doc-title b)',
  '.steps-rows :is(.steps-row-text, .steps-answer)',
  '.steps-now-text > :is(b, span)',
].join(', ');

/** Whether a cell is cut short: its text runs past its width. A cell drawn with no width has nothing to show. */
export const isCutShort = ({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }): boolean => clientWidth > 0 && scrollWidth > clientWidth + 1;

type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the overlay goes in its node, in the node's own pixels: over the cell, as wide. `scale` is how much bigger
 * the node is drawn on screen than its own size, which is the board's zoom.
 */
export function overlayFrame(cell: Box, node: Box, scale: number): { left: number; top: number; width: number } {
  const by = scale > 0 ? scale : 1;
  return { left: (cell.left - node.left) / by, top: (cell.top - node.top) / by, width: cell.width / by };
}

/** The first colour behind `element` that isn't see-through, up to `stop`: the overlay's ground, so it reads as the card. */
function groundOf(element: HTMLElement, stop: HTMLElement): string {
  for (let at: HTMLElement | null = element; at !== null; at = at === stop ? null : at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour !== '' && colour !== 'transparent' && !/rgba?\(.*,\s*0\)$/.test(colour)) return colour;
  }
  return '';
}

/** Listens on `root` (the board) for a pointer or focus on a cut-short cell, and lays its line over it. */
export function installWholeLines(root: HTMLElement): () => void {
  let shown: { cell: HTMLElement; overlay: HTMLElement; watch: () => void } | undefined;
  const hide = () => {
    shown?.overlay.remove();
    shown?.watch();
    shown = undefined;
  };
  // Selected, a card wraps its lines in place, so none is cut short there.
  const wraps = (node: HTMLElement) => node.classList.contains('selected');
  const show = (cell: HTMLElement) => {
    if (shown?.cell === cell) return;
    hide();
    const node = cell.closest<HTMLElement>('.react-flow__node');
    if (node === null || wraps(node) || !isCutShort(cell)) return;
    const nodeBox = node.getBoundingClientRect();
    const frame = overlayFrame(cell.getBoundingClientRect(), nodeBox, nodeBox.width / (node.offsetWidth || nodeBox.width));
    const style = getComputedStyle(cell);
    const overlay = document.createElement('div');
    overlay.className = 'whole-line';
    overlay.dataset.testid = 'whole-line';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.textContent = cell.textContent;
    Object.assign(overlay.style, {
      left: `${frame.left}px`,
      top: `${frame.top}px`,
      width: `${frame.width}px`,
      font: style.font,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform,
      color: style.color,
      backgroundColor: groundOf(cell, node),
    });
    node.append(overlay);
    // It goes once the line is whole on its own: its card selected, or its row made wide enough or wrapped.
    const check = () => {
      if (wraps(node) || !isCutShort(cell) || !cell.isConnected) hide();
    };
    const selecting = new MutationObserver(check);
    selecting.observe(node, { attributes: true, attributeFilter: ['class'] });
    const sizing = new ResizeObserver(check);
    sizing.observe(cell);
    shown = {
      cell,
      overlay,
      watch: () => {
        selecting.disconnect();
        sizing.disconnect();
      },
    };
  };
  const cellAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(CUT_CELLS) : null);
  const over = (event: PointerEvent) => {
    const cell = cellAt(event.target);
    if (cell !== null && root.contains(cell)) show(cell);
    else hide();
  };
  const out = (event: PointerEvent) => {
    if (shown !== undefined && !(event.relatedTarget instanceof Node && shown.cell.contains(event.relatedTarget))) hide();
  };
  const focused = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // A row focused (a step's button) shows its own line. A card's node takes focus as it is clicked, and nothing
    // searches a whole card for a line, so that shows none.
    const cell = target.closest<HTMLElement>(CUT_CELLS) ?? target.closest('.listcard-row, .steps-row')?.querySelector<HTMLElement>(CUT_CELLS) ?? null;
    if (cell !== null) show(cell);
  };
  root.addEventListener('pointerover', over);
  root.addEventListener('pointerout', out);
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('focusin', focused);
  root.addEventListener('focusout', hide);
  // A scroll or a wheel moves the cell from under its overlay.
  root.addEventListener('scroll', hide, true);
  root.addEventListener('wheel', hide, { capture: true, passive: true });
  return () => {
    hide();
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerout', out);
    root.removeEventListener('pointerdown', hide, true);
    root.removeEventListener('focusin', focused);
    root.removeEventListener('focusout', hide);
    root.removeEventListener('scroll', hide, true);
    root.removeEventListener('wheel', hide, { capture: true });
  };
}
