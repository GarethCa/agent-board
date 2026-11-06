import { pastedImages } from './composer-input';
import { isTyping } from '../board/use-tile-moves';

/** The panes an agent's session shows in: the session window over the board, and a tile expanded in place on it. */
const PANE = '.session-window, .expanded-tile-body';

/** The pane the user last pointed into or focused, or none when it was anywhere else, the board included. */
let lastPane: Element | null = null;

const shown = (element: Element) => element.getClientRects().length > 0;

/**
 * The pane a paste with the focus on the page belongs to: an open session window, which covers the board, else the
 * expanded tile the user last worked in. None when they last worked on the board, so a paste there is the board's.
 */
function pastePane(): Element | null {
  const windows = [...document.querySelectorAll('.session-window')].filter(shown);
  if (windows.length > 0) return windows[windows.length - 1]!;
  return lastPane !== null && lastPane.isConnected && shown(lastPane) ? lastPane : null;
}

/**
 * The view a paste in `pane` belongs to: of the composers' fields and terminals showing (a hidden tab or the other of
 * chat and terminal doesn't count), the one in the pane the user has focused, else the first. In a split the agent's
 * pane in its chat view has no terminal; its composer, which sits outside the panes, is its view.
 */
function viewIn(pane: Element): HTMLElement | undefined {
  const views = [...pane.querySelectorAll<HTMLElement>('.composer-field textarea, .terminal-pane')].filter(shown);
  const focused = [...pane.querySelectorAll<HTMLElement>('.shell-pane[data-focused="true"]')].filter(shown);
  const split = focused.find((each) => each.closest('.session-tab-view[data-focused]') !== null) ?? focused[0];
  if (split !== undefined) {
    const own = views.find((view) => split.contains(view));
    return own ?? (split.hasAttribute('data-agent') ? views.find((view) => view.matches('.composer-field textarea')) : undefined) ?? views[0];
  }
  const inFocused = views.find((view) => view.closest('[data-focused]') !== null);
  // The focused window pane shows no terminal: it is the agent's, in its chat view.
  return inFocused ?? views.find((view) => view.matches('.composer-field textarea')) ?? views[0];
}

/**
 * Sends a paste with the focus on the page to the view `pane` shows: the composer's field, or the terminal. A pane that
 * shows neither still takes it, so the board under the window never does.
 */
function route(event: ClipboardEvent, pane: Element): void {
  const data = event.clipboardData;
  if (data === null) return;
  event.preventDefault();
  event.stopPropagation();
  const view = viewIn(pane);
  if (view === undefined) return;
  if (view instanceof HTMLTextAreaElement) {
    if (pastedImages(data).length > 0) return void view.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    // The composer's own paste handles images. Text goes in through the editing command, not a value set, so it keeps
    // the field's undo and React's onChange.
    view.focus();
    document.execCommand('insertText', false, data.getData('text/plain'));
    return;
  }
  const field = view.querySelector('.xterm-helper-textarea') ?? view;
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

const track = (event: Event) => {
  lastPane = (event.target as Element | null)?.closest?.(PANE) ?? null;
};
const onPaste = (event: ClipboardEvent) => {
  if (event.defaultPrevented || isTyping(event)) return;
  const pane = pastePane();
  if (pane !== null) route(event, pane);
};

let watchers = 0;

/**
 * While an agent's session shows anywhere, a paste with the focus on the page (after a click in a chat's transcript, say)
 * goes to the pane the user is in, as its own field would have taken it, and the board never sees it. Each caller
 * counts once; the returned function stops the watch.
 */
export function watchPastePane(): () => void {
  if (watchers++ === 0) {
    document.addEventListener('pointerdown', track, true);
    document.addEventListener('focusin', track, true);
    window.addEventListener('paste', onPaste, true);
  }
  return () => {
    if (--watchers > 0) return;
    document.removeEventListener('pointerdown', track, true);
    document.removeEventListener('focusin', track, true);
    window.removeEventListener('paste', onPaste, true);
    lastPane = null;
  };
}
