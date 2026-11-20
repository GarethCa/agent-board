// Drawing the eye to a tile ⌘K picked: a pulse once the board has flown to it, and the focus on it. Both wait for React
// Flow to draw the node, which it only does once it is in view.
import { tokenNumber } from '../theme';

/** How long to look for a node to be drawn before giving up: the board moving to it, an expanded tile laid out. */
const DRAWN_WITHIN_MS = 1500;

/** Calls `found` with the first element matching `selector` inside the node `nodeId`, once it is drawn. */
function whenDrawn(nodeId: string, selector: string, found: (element: HTMLElement) => void): void {
  const until = performance.now() + DRAWN_WITHIN_MS;
  const look = () => {
    const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    const element = selector === '' ? node : node?.querySelector(selector);
    if (element instanceof HTMLElement) found(element);
    else if (performance.now() < until) requestAnimationFrame(look);
  };
  look();
}

/**
 * Pulses the tile's node, after `delayMs` (the board flying there), as often as the theme says. Its look is
 * `[data-pulse]` in app.css: a ring that pulses, or holds still with reduced motion.
 */
export function pulseTile(nodeId: string, delayMs: number): void {
  setTimeout(
    () =>
      whenDrawn(nodeId, '', (node) => {
        // Again from the start, if it is still pulsing from the last pick.
        node.removeAttribute('data-pulse');
        void node.offsetWidth;
        node.setAttribute('data-pulse', '');
        setTimeout(() => node.removeAttribute('data-pulse'), tokenNumber('--motion-pulse') * tokenNumber('--pulse-count'));
      }),
    delayMs,
  );
}

/** The tile node `focusTile` gave the focus, until it loses it. */
let picked: HTMLElement | undefined;

/** The tile node `focusTile` gave the focus, while it keeps it: Esc there is not the board's. */
export const pickedTile = (): HTMLElement | undefined => (picked?.isConnected === true ? picked : undefined);

/**
 * Puts the focus on the tile's node after `delayMs` (the board flying there), unless something has taken it meanwhile:
 * only from nothing, or the page.
 */
export function focusTile(nodeId: string, delayMs: number): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    whenDrawn(nodeId, '', (node) => {
      node.focus({ preventScroll: true });
      if (document.activeElement !== node) return;
      picked = node;
      node.addEventListener('blur', () => (picked = picked === node ? undefined : picked), { once: true });
    });
  }, delayMs);
}
