import { useEffect, useRef } from 'react';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { SCROLLBACK_LINES, type Harness, type SessionInfo } from '@agent-board/daemon/protocol';
import { localWebLinks } from '@agent-board/daemon/web-url';
import { commandKey } from '../keys';
import { token, tokenNumber } from '../theme';
import { chosenFontSize, FONT_STEP, onFontSize, PINCH_RATE, setFontSize, sizeKey } from './terminal-size';
import { newlineKey } from './newline-keys';
import { throttled } from './throttle';
import { compensateForScale } from './zoomed-mouse';
import { useWebLinkOpener } from './web-links';

/** The click that opens a local address in the output in a web tab, as the platform writes it. */
const COMMAND_CLICK = navigator.platform.startsWith('Mac') ? '⌘-click' : 'Ctrl-click';

/** How often the terminal refits to its element while that is being resized, e.g. by dragging its window's edge. */
const REFIT_INTERVAL_MS = 80;

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
  /** Opens a local address ⌘-clicked in the output in a web tab, in a window that has tabs; read at the click. */
  const webOpener = useWebLinkOpener();
  const openWeb = useRef(webOpener);
  openWeb.current = webOpener;

  useEffect(() => {
    const element = container.current!;
    const api = window.agentBoard.sessions;
    const status = (next: PaneStatus) => report.current(next);
    const look = () => {
      const look = terminalLook(element);
      return { ...look, fontSize: Math.round(chosenFontSize() ?? look.fontSize!) };
    };
    const terminal = new Terminal({ ...look(), cursorBlink: true, scrollback: SCROLLBACK_LINES });
    // A theme change (the theme sets data-theme on <html>) restyles the terminal, which doesn't see CSS.
    const themeChange = new MutationObserver(() => Object.assign(terminal.options, look()));
    themeChange.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // The text size is the terminal's own: ⌘+ ⌘- ⌘0 and a pinch over it change it, not the board's zoom or the page's.
    // A new size refits the terminal, which resizes the session.
    const resized = onFontSize(() => {
      terminal.options.fontSize = look().fontSize;
      fit.fit();
    });
    const size = () => chosenFontSize() ?? terminal.options.fontSize!;
    const keyDown = (event: KeyboardEvent) => {
      const action = commandKey(event) ? sizeKey(event.key) : undefined;
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
    // A dev server's local address in the output (BI2) opens in a web tab of the window on a ⌘-click (Ctrl off
    // macOS): a plain click stays the terminal's.
    const links = terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const line = terminal.buffer.active.getLine(y - 1)?.translateToString(true);
        if (openWeb.current === undefined || line === undefined) return callback(undefined);
        callback(
          localWebLinks(line).map(({ url, start, end }) => ({
            range: { start: { x: start + 1, y }, end: { x: end, y } },
            text: url,
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => {
              if (commandKey(event)) openWeb.current?.(url);
            },
            hover: () => (element.title = `${COMMAND_CLICK} to open in a web tab`),
            leave: () => element.removeAttribute('title'),
          })),
        );
      },
    });
    terminalRef.current = terminal;
    terminal.open(element);
    // The board's zoom scales the terminal, which xterm's mouse mapping doesn't know.
    compensateForScale(terminal);
    fit.fit();

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
        detach = api.attach(sessionId, (event) => {
          switch (event.type) {
            case 'session.snapshot':
              terminal.reset();
              terminal.write(event.data);
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
      const newline = newlineKey(harnessRef.current, event);
      if (newline === undefined) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        api.write(sessionId, newline);
      }
      return false;
    });
    const resize = terminal.onResize((size) => void api.resize(sessionId, size).catch(() => {}));
    // Throttled: dragging a window's edge resizes the element every frame, and each new size resizes the session.
    const refit = throttled(() => fit.fit(), REFIT_INTERVAL_MS);
    const observer = new ResizeObserver(refit.call);
    observer.observe(element);
    if (focusedRef.current && autoFocusRef.current) terminal.focus();

    return () => {
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
    };
  }, [sessionId]);

  useEffect(() => {
    if (focused && (mounted.current || autoFocusRef.current)) terminalRef.current?.focus();
    mounted.current = true;
  }, [focused]);

  return <div ref={container} className="terminal-pane nowheel" data-testid="session-terminal" />;
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
