import { useEffect, useRef, type RefObject } from 'react';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { SCROLLBACK_LINES, type Harness, type SessionInfo } from '@agent-board/daemon/protocol';
import { bufferLinks, hyperlinkAddress, hyperlinkHint, linkHint, linkTarget, type BufferRow } from './terminal-links';
import { commandKey, isMac } from '../keys';
import { keyText } from '../keys/registry';
import { token, tokenNumber } from '../theme';
import { chosenFontSize, FONT_STEP, onFontSize, PINCH_RATE, setFontSize, terminalSizeKey } from './terminal-size';
import { macLineEditKey, newlineKey } from './newline-keys';
import { throttled } from './throttle';
import { compensateForScale } from './zoomed-mouse';
import { useWebLinkOpener } from './web-links';

/** The click that opens a local address in the output in a web tab, as the platform writes it. */

/** How often the terminal refits to its element while that is being resized, e.g. by dragging its window's edge. */
const REFIT_INTERVAL_MS = 80;

/**
 * A prototype, off unless the board was opened with `?terminalCache=1` (main sets it from `AGENT_BOARD_TERMINAL_CACHE`,
 * never in a packaged build): a pane's terminal outlives the pane, still attached, so a pane mounted again for its
 * session (an expanded tile panned back into view) shows it at once, rather than building a terminal and parsing the
 * session's snapshot again. Past `KEPT_LIMIT` unmounted ones, the longest unseen is let go.
 */
// Unit tests import this module under node, where there is no `location`.
const KEEP_TERMINALS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('terminalCache') === '1';
const KEPT_LIMIT = 24;

/** What a kept terminal reports to and reads from: the pane showing it now. */
interface PaneBinding {
  report: RefObject<(status: PaneStatus) => void>;
  harness: RefObject<Harness | null>;
  openWeb: RefObject<ReturnType<typeof useWebLinkOpener>>;
}

interface KeptTerminal {
  host: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  binding: PaneBinding;
  last: { status?: PaneStatus };
  shown: boolean;
  dispose(): void;
}

/** The kept terminals by session id, the longest unseen first: each moves to the end as it leaves its pane. */
const kept = new Map<string, KeptTerminal>();

/** Takes a kept terminal out of its pane, as the most recently seen, and lets go of the longest unseen past the limit. */
function park(sessionId: string, entry: KeptTerminal): void {
  entry.host.remove();
  entry.shown = false;
  kept.delete(sessionId);
  kept.set(sessionId, entry);
  letGoOfUnseen();
}

function letGoOfUnseen(): void {
  const unseen = [...kept].filter(([, each]) => !each.shown);
  for (const [sessionId, each] of unseen.slice(0, Math.max(0, unseen.length - KEPT_LIMIT))) {
    kept.delete(sessionId);
    each.dispose();
  }
}

/** Where a pane's attachment to its session stands. */
export type AttachState = 'attaching' | 'attached' | 'exited' | 'detached' | 'unavailable';

export interface PaneStatus {
  state: AttachState;
  /** The session as it ended, once `exited`. */
  ended?: SessionInfo;
  /** Why it is `unavailable`. */
  problem?: string;
}

interface TerminalPaneProps {
  sessionId: string;
  /** Hears how the attachment goes. Read when the pane mounts. */
  onStatus(status: PaneStatus): void;
  /** Whether the pane takes the keyboard: it is the window's only pane or the focused one. True by default. */
  focused?: boolean;
  /**
   * Whether a focused pane takes the keyboard as it mounts. True by default; an expanded tile's terminal waits to be
   * clicked, so Esc and the board's keys still reach the board when it expands.
   */
  autoFocus?: boolean;
  /** The harness the session runs, whose newline Shift+Enter and Option+Enter send; null or absent for a plain shell. */
  harness?: Harness | null;
}

/**
 * One session's terminal, attached for as long as the pane is mounted: the daemon's snapshot first, then its live
 * output. It sizes the session to itself. Unmounting detaches; the session keeps running.
 */
export function TerminalPane({ sessionId, onStatus, focused = true, autoFocus = true, harness = null }: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>(null);
  /** Whether the pane has the keyboard now, for the mount effect, which must not re-run when it changes. */
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  /** Whether it took the keyboard as it mounted, read once. */
  const autoFocusRef = useRef(autoFocus);
  /** Whether it has mounted, after which it takes the keyboard whenever it becomes the focused pane. */
  const mounted = useRef(false);
  const report = useRef(onStatus);
  report.current = onStatus;
  /** Read at each key, so the agent arriving after the pane mounts doesn't re-attach it. */
  const harnessRef = useRef(harness);
  harnessRef.current = harness;
  /** Opens an address ⌘-clicked in the output in a web tab, in a window that has tabs; read at the click. */
  const webOpener = useWebLinkOpener();
  const openWeb = useRef(webOpener);
  openWeb.current = webOpener;

  useEffect(() => {
    const mountedAt = performance.now();
    timing('terminal.mount', mountedAt, sessionId);
    const pane = container.current!;
    const binding: PaneBinding = { report, harness: harnessRef, openWeb };
    const reusable = KEEP_TERMINALS ? kept.get(sessionId) : undefined;
    if (reusable !== undefined && !reusable.shown) {
      Object.assign(reusable.binding, binding);
      reusable.shown = true;
      pane.appendChild(reusable.host);
      terminalRef.current = reusable.terminal;
      reusable.fit.fit();
      timing('terminal.open', mountedAt, sessionId);
      if (reusable.last.status !== undefined) report.current(reusable.last.status);
      if (focusedRef.current && autoFocusRef.current) reusable.terminal.focus();
      return () => {
        terminalRef.current = null;
        park(sessionId, reusable);
      };
    }
    // Kept, it draws into an element of its own, which moves to whichever pane shows it.
    const keep = KEEP_TERMINALS && reusable === undefined;
    const element = keep ? document.createElement('div') : pane;
    if (keep) {
      element.className = 'terminal-host';
      pane.appendChild(element);
    }
    const last: KeptTerminal['last'] = {};
    const api = window.agentBoard.sessions;
    const status = (next: PaneStatus) => {
      last.status = next;
      binding.report.current(next);
    };
    const look = () => {
      // A kept terminal out of every pane reads the theme from the page.
      const look = terminalLook(element.isConnected ? element : document.documentElement);
      return { ...look, fontSize: Math.round(chosenFontSize() ?? look.fontSize!) };
    };
    const terminal = new Terminal({ ...look(), cursorBlink: true, scrollback: SCROLLBACK_LINES });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // A theme or design change (data-theme, data-design on <html>) restyles the terminal, which doesn't see CSS. The
    // design changes its font, so its cells too: it refits, which resizes the session.
    const themeChange = new MutationObserver(() => {
      Object.assign(terminal.options, look());
      fit.fit();
    });
    themeChange.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-design'] });
    // The text size is the terminal's own: ⌘+ ⌘- ⌘0 and a pinch over it change it, not the board's zoom or the page's.
    // A new size refits the terminal, which resizes the session.
    const resized = onFontSize(() => {
      terminal.options.fontSize = look().fontSize;
      fit.fit();
    });
    const size = () => chosenFontSize() ?? terminal.options.fontSize!;
    const keyDown = (event: KeyboardEvent) => {
      const action = terminalSizeKey(event, isMac);
      if (action === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setFontSize(action === 'reset' ? undefined : size() + (action === 'bigger' ? FONT_STEP : -FONT_STEP));
    };
    // A pinch reaches Chromium as a wheel with Ctrl.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setFontSize(size() - event.deltaY * PINCH_RATE);
    };
    element.addEventListener('keydown', keyDown, true);
    element.addEventListener('wheel', wheel, { passive: false });
    // An address in the output (also one wrapped over rows) opens on a ⌘-click (Ctrl off macOS), a plain click staying
    // the terminal's: in a web tab of the window, or with Shift in the OS browser (https only), as Chat opens its links.
    const rowAt = (y: number): BufferRow | undefined => {
      const row = terminal.buffer.active.getLine(y - 1);
      if (row === undefined) return undefined;
      const cells = Array.from({ length: row.length }, (_, x) => {
        const cell = row.getCell(x);
        return cell === undefined || cell.getWidth() === 0 ? undefined : cell.getChars();
      });
      return { cells, wrapped: row.isWrapped };
    };
    const openLink = (url: string, event: MouseEvent) => {
      if (!commandKey(event)) return;
      const target = linkTarget(url, event.shiftKey, binding.openWeb.current !== undefined);
      // Shift-click extends the terminal's selection, which is not what a click on a link means.
      if (event.shiftKey) terminal.clearSelection();
      if (target === 'web-tab') binding.openWeb.current?.(url);
      else if (target === 'browser') void window.agentBoard.trackers.openLink(url).catch(() => {});
    };
    const hint = (url: string) => (element.title = linkHint(url, binding.openWeb.current !== undefined, { open: keyText('window.openLink'), browser: keyText('window.openLinkBrowser') }));
    const leave = () => element.removeAttribute('title');
    const links = terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const found = bufferLinks(rowAt, y, terminal.cols).filter(({ url }) => linkTarget(url, false, binding.openWeb.current !== undefined) !== undefined || linkTarget(url, true, false) !== undefined);
        callback(
          found.length === 0
            ? undefined
            : found.map(({ url, start, end }) => ({
                range: { start, end },
                text: url,
                decorations: { underline: true, pointerCursor: true },
                activate: (event) => openLink(url, event),
                hover: () => hint(url),
                leave,
              })),
        );
      },
    });
    // An OSC 8 hyperlink (Claude Code writes its long addresses so, whole, however it wraps them) opens the same way,
    // by the same address rules. Without a handler of ours xterm would confirm and open a window of its own.
    terminal.options.linkHandler = {
      activate(event, text) {
        const url = hyperlinkAddress(text);
        if (url !== undefined) openLink(url, event);
      },
      hover(_event, text) {
        element.title = hyperlinkHint(text, binding.openWeb.current !== undefined, { open: keyText('window.openLink'), browser: keyText('window.openLinkBrowser') });
      },
      leave,
    };
    terminalRef.current = terminal;
    terminal.open(element);
    // The board's zoom scales the terminal, which xterm's mouse mapping doesn't know.
    compensateForScale(terminal);
    fit.fit();
    timing('terminal.open', mountedAt, sessionId);

    let disposed = false;
    let exited = false;
    let detach: (() => void) | undefined;
    // Size the session to this pane before attaching, so the snapshot arrives laid out for it: only a pane laid out
    // on the screen. One hidden (a tab not showing) has no size of its own, and would shrink the session to
    // xterm's 80×24 under whichever window shows it; it sizes the session once it shows, as it refits.
    const laidOut = element.getClientRects().length > 0;
    void (laidOut ? api.resize(sessionId, { cols: terminal.cols, rows: terminal.rows }).catch(() => {}) : Promise.resolve())
      .then(() => {
        if (disposed) return;
        const attaching = performance.now();
        detach = api.attach(sessionId, (event) => {
          switch (event.type) {
            case 'session.snapshot':
              terminal.reset();
              terminal.write(event.data, () => timing('terminal.snapshot', attaching, { sessionId, bytes: event.data.length }));
              status({ state: 'attached' });
              break;
            case 'session.output':
              terminal.write(event.data);
              break;
            case 'session.exited':
              exited = true;
              status({ state: 'exited', ended: event.session });
              break;
            case 'session.detached':
              if (!exited) status({ state: 'detached' });
              break;
            case 'session.attachFailed':
              status({ state: 'unavailable', problem: event.message });
              break;
          }
        });
      });
    const input = terminal.onData((data) => api.write(sessionId, data));
    // Shift+Enter and Option+Enter put a line break in an agent's message rather than sending it. Every event of the
    // key is kept from xterm, which would send its own CR; the sequence goes once, on keydown.
    terminal.attachCustomKeyEventHandler((event) => {
      const sequence = newlineKey(binding.harness.current, event) ?? macLineEditKey(event);
      if (sequence === undefined) return true;
      if (event.type === 'keydown') {
        // The board's delete key ignores keys typed into xterm's textarea, so ⌘⌫ here can't also delete a selection.
        event.preventDefault();
        api.write(sessionId, sequence);
      }
      return false;
    });
    const resize = terminal.onResize((size) => void api.resize(sessionId, size).catch(() => {}));
    // Throttled: dragging a window's edge resizes the element every frame, and each new size resizes the session.
    // A kept terminal out of every pane has no size: it keeps the session's until it shows again.
    const refit = throttled(() => element.isConnected && fit.fit(), REFIT_INTERVAL_MS);
    const observer = new ResizeObserver(refit.call);
    observer.observe(element);
    if (focusedRef.current && autoFocusRef.current) terminal.focus();

    const dispose = () => {
      disposed = true;
      themeChange.disconnect();
      resized();
      element.removeEventListener('keydown', keyDown, true);
      element.removeEventListener('wheel', wheel);
      terminalRef.current = null;
      observer.disconnect();
      refit.cancel();
      input.dispose();
      links.dispose();
      resize.dispose();
      detach?.();
      terminal.dispose();
      if (keep) element.remove();
    };
    if (!keep) return dispose;
    const entry: KeptTerminal = { host: element as HTMLDivElement, terminal, fit, binding, last, shown: true, dispose };
    kept.set(sessionId, entry);
    return () => {
      terminalRef.current = null;
      park(sessionId, entry);
    };
  }, [sessionId]);

  useEffect(() => {
    if (focused && (mounted.current || autoFocusRef.current)) terminalRef.current?.focus();
    mounted.current = true;
  }, [focused]);

  return <div ref={container} className="terminal-pane nowheel" data-testid="session-terminal" />;
}

/**
 * A User Timing measure from `start` to now, for profiles and the rendering benchmark (e2e/render-bench.spec.ts): a
 * terminal's mount, its open and fit, and its snapshot from attaching to parsed. Cleared as soon as it is written, so the
 * page's timeline never fills with them; a `PerformanceObserver` still hears each one.
 */
function timing(name: string, start: number, detail: unknown): void {
  performance.measure(name, { start, detail });
  performance.clearMeasures(name);
}

/**
 * The terminal's font and colours from the theme tokens: xterm paints to a canvas, so it takes resolved values, not
 * var(). The 16 ANSI colours are the theme's too (`--ansi-*`), so a theme can bring its own terminal palette.
 */
function terminalLook(element: Element): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'theme'> {
  return {
    fontFamily: token('--font-mono', element),
    fontSize: tokenNumber('--font-size-md', element),
    theme: {
      background: token('--window-bg', element),
      foreground: token('--window-ink', element),
      cursor: token('--window-ink', element),
      cursorAccent: token('--window-bg', element),
      selectionBackground: token('--window-selection', element),
      black: token('--ansi-black', element),
      red: token('--ansi-red', element),
      green: token('--ansi-green', element),
      yellow: token('--ansi-yellow', element),
      blue: token('--ansi-blue', element),
      magenta: token('--ansi-magenta', element),
      cyan: token('--ansi-cyan', element),
      white: token('--ansi-white', element),
      brightBlack: token('--ansi-bright-black', element),
      brightRed: token('--ansi-bright-red', element),
      brightGreen: token('--ansi-bright-green', element),
      brightYellow: token('--ansi-bright-yellow', element),
      brightBlue: token('--ansi-bright-blue', element),
      brightMagenta: token('--ansi-bright-magenta', element),
      brightCyan: token('--ansi-bright-cyan', element),
      brightWhite: token('--ansi-bright-white', element),
    },
  };
}
