import { useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { SCROLLBACK_LINES, type Harness, type SessionInfo } from '@agent-board/daemon/protocol';
import { bufferLinks, hyperlinkAddress, hyperlinkHint, linkHint, linkTarget, type BufferRow } from './terminal-links';
import { commandKey, isMac } from '../keys';
import { keyText } from '../keys/registry';
import { token, tokenNumber } from '../theme';
import { chosenFontSize, FONT_STEP, onFontSize, PINCH_RATE, setFontSize, terminalSizeKey } from './terminal-size';
import { macLineEditKey, newlineKey } from './newline-keys';
import { keepPastedImages, pastedImages } from './composer-input';
import { ipcErrorMessage } from '../../../shared/errors';
import { throttled } from './throttle';
import { compensateForScale } from './zoomed-mouse';
import { useWebLinkOpener } from './web-links';
import { gpuPool, type GpuPool } from './terminal-gpu';
import { onBoardSettled, sharpen } from './terminal-sharpness';
import { keptTerminals, terminalBytes, type KeptEntry } from './kept-terminals';
import { subscribe, useViewSettings, useViewSettingsLoaded, viewSettings, viewSettingsLoaded } from '../board/view-settings';

/** The click that opens a local address in the output in a web tab, as the platform writes it. */

/** How often the terminal refits to its element while that is being resized, e.g. by dragging its window's edge. */
const REFIT_INTERVAL_MS = 80;

/**
 * With the setting on, a pane's terminal outlives the pane, still attached, so a pane mounted again for its session (an
 * expanded tile panned back into view) shows it at once, rather than building a terminal and parsing the session's
 * snapshot again (`kept-terminals.ts`). `?terminalCache=<bytes>`, a positive number, turns it on whatever the setting, with
 * that budget: main sets it from `AGENT_BOARD_TERMINAL_CACHE`, never in a packaged build, for the benchmarks and tests.
 */
// Unit tests import this module under node, where there is no `location`.
const asked = typeof location === 'undefined' ? 0 : Number(new URLSearchParams(location.search).get('terminalCache'));
const CACHE_BYTES = asked > 0 ? asked : null;

/** What a page's parked terminals may hold: about ten sessions with a full scrollback, at 100 columns. */
const KEPT_BYTES = CACHE_BYTES ?? 150_000_000;

/** Set by main from `AGENT_BOARD_TERMINAL_RENDERER=dom` for tests, never in a packaged build: no terminal uses the GPU. */
const DOM_ONLY = typeof location !== 'undefined' && new URLSearchParams(location.search).get('terminalRenderer') === 'dom';

/** The page's WebGL contexts for its terminals, made with its first terminal. */
let pool: GpuPool | undefined;

function gpu(): GpuPool {
  if (pool !== undefined) return pool;
  // Off until the window has read the saved setting: a terminal never takes WebGL the user turned off.
  const made = gpuPool({ createAddon: () => new WebglAddon(), enabled: false });
  // The glyph atlas keeps the glyphs as first drawn: a font that loads later (the bundled mono, a theme's) redraws them.
  document.fonts.addEventListener('loadingdone', () => made.clearAtlases());
  pool = made;
  return made;
}

/** What a kept terminal reports to and reads from: the pane showing it now. */
interface PaneBinding {
  report: RefObject<(status: PaneStatus) => void>;
  harness: RefObject<Harness | null>;
  openWeb: RefObject<ReturnType<typeof useWebLinkOpener>>;
}

/** What a parked terminal reports to and reads from: no pane. */
const NO_PANE: PaneBinding = { report: { current: () => {} }, harness: { current: null }, openWeb: { current: undefined } };

interface KeptTerminal extends KeptEntry {
  terminal: Terminal;
  /** The run of the session it follows, once a pane has said. */
  startedAt?: string;
  /** Whether it has ever been laid out in a pane. One that never was is at xterm's default size, not the session's. */
  everShown(): boolean;
  /** Shows it in `pane`, which it reports to. It says what it last reported, and whether the session is still its size. */
  enter(pane: HTMLElement, binding: PaneBinding): { status?: PaneStatus; sameSize: Promise<boolean> };
  /** Takes it out of its pane. */
  leave(): void;
}

const kept = keptTerminals<KeptTerminal>({ budget: KEPT_BYTES });

/** Whether a terminal built or brought back now is kept: read at the mount, so a change of the setting re-attaches no pane. */
function keepingTerminals(): boolean {
  return CACHE_BYTES !== null || (viewSettingsLoaded() && viewSettings().keepTerminals);
}

let followingSetting = false;

/** From the first kept terminal: turned off, the setting lets them all go, though no pane may be mounted to hear it. */
function letGoWhenTurnedOff(): void {
  if (followingSetting) return;
  followingSetting = true;
  subscribe(() => {
    if (!keepingTerminals() && viewSettingsLoaded()) kept.forgetAll('setting');
  });
}

function park(sessionId: string, entry: KeptTerminal): void {
  entry.leave();
  if (!entry.everShown()) kept.forget(sessionId, 'hidden');
  kept.park(sessionId);
  // What the parked terminals hold now, for the benchmark.
  timing('terminal.parked', performance.now(), kept.parked());
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
  /**
   * When the session started, for an agent's, once it is known: a relaunch keeps its session id, and its pane may mount
   * again before the old session's end arrives, so a kept terminal serves only the run it followed.
   */
  startedAt?: string;
}

/**
 * One session's terminal: the daemon's snapshot first, then its live output. It sizes the session to itself. Unmounting
 * detaches, or with the setting on parks the terminal, still attached, for the next pane of its session
 * (`kept-terminals.ts`). The session keeps running.
 */
export function TerminalPane({ sessionId, onStatus, focused = true, autoFocus = true, harness = null, startedAt }: TerminalPaneProps) {
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
  const { gpuTerminals } = useViewSettings();
  const settingsLoaded = useViewSettingsLoaded();
  /** Moves on when a kept terminal turns out to be stale as it comes back, to build a new one. */
  const [rebuilds, setRebuilds] = useState(0);

  // Settings › Advanced › Terminals, followed live: turned off, every terminal goes back to the DOM renderer at once.
  useEffect(() => gpu().setEnabled(!DOM_ONLY && settingsLoaded && gpuTerminals), [settingsLoaded, gpuTerminals]);

  useEffect(() => {
    const mountedAt = performance.now();
    const pane = container.current!;
    const binding: PaneBinding = { report, harness: harnessRef, openWeb };
    // One whose run isn't known yet suits: a pop-out's pane mounts before its agent arrives, and again as it does.
    const keeping = keepingTerminals();
    const reusable = keeping ? kept.take(sessionId, (entry) => startedAt === undefined || entry.startedAt === undefined || entry.startedAt === startedAt) : undefined;
    // Whether it takes a kept terminal over, which parses no snapshot.
    timing('terminal.mount', mountedAt, { sessionId, kept: reusable !== undefined });
    if (reusable !== undefined) {
      terminalRef.current = reusable.terminal;
      reusable.startedAt ??= startedAt;
      const { status, sameSize } = reusable.enter(pane, binding);
      timing('terminal.open', mountedAt, sessionId);
      if (status !== undefined) report.current(status);
      if (focusedRef.current && autoFocusRef.current) reusable.terminal.focus();
      let left = false;
      // Another window resized the session while this was parked: what it took meanwhile was laid out for that size, so
      // the snapshot is the true screen.
      void sameSize.then((same) => {
        if (same || left) return;
        kept.forget(sessionId, 'resized');
        setRebuilds((count) => count + 1);
      });
      return () => {
        left = true;
        terminalRef.current = null;
        park(sessionId, reusable);
      };
    }
    // Kept, it draws into an element of its own, which moves to whichever pane shows it.
    const keep = keeping && !kept.has(sessionId);
    const element = keep ? document.createElement('div') : pane;
    if (keep) {
      element.className = 'terminal-host';
      pane.appendChild(element);
    }
    let lastStatus: PaneStatus | undefined;
    /** Whether it is in a pane, rather than parked. */
    let inPane = true;
    const api = window.agentBoard.sessions;
    const status = (next: PaneStatus) => {
      lastStatus = next;
      binding.report.current(next);
    };
    const look = () => {
      // A kept terminal out of every pane reads the theme from the page.
      const look = terminalLook(element.isConnected ? element : document.documentElement);
      return { ...look, fontSize: Math.round(chosenFontSize() ?? look.fontSize!) };
    };
    const terminal = new Terminal({ ...look(), cursorBlink: true, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    // Claude Code and Codex draw every emoji grapheme (also ❤️, a skin tone, a ZWJ family) two cells wide; xterm's own
    // tables count it as one or more, shifting the text and the link hit areas after it. Loading the addon makes its
    // grapheme widths the active ones.
    terminal.loadAddon(new UnicodeGraphemesAddon());
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // A theme or design change (data-theme, data-design on <html>) restyles the terminal, which doesn't see CSS. The
    // design changes its font, so its cells too: it refits, which resizes the session.
    const themeChange = new MutationObserver(() => {
      Object.assign(terminal.options, look());
      // A parked terminal has no size: it fits as it comes back.
      if (element.isConnected) fit.fit();
    });
    themeChange.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-design'] });
    // The text size is the terminal's own: ⌘+ ⌘- ⌘0 and a pinch over it change it, not the board's zoom or the page's.
    // A new size refits the terminal, which resizes the session.
    const resized = onFontSize(() => {
      terminal.options.fontSize = look().fontSize;
      if (element.isConnected) fit.fit();
    });
    const size = () => chosenFontSize() ?? terminal.options.fontSize!;
    const keyDown = (event: KeyboardEvent) => {
      const action = terminalSizeKey(event, isMac);
      if (action === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setFontSize(action === 'reset' ? undefined : size() + (action === 'bigger' ? FONT_STEP : -FONT_STEP));
    };
    element.addEventListener('keydown', keyDown, true);
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
    // It stays sharp under that zoom on WebGL, redrawn each time the board comes to rest.
    const sharp = sharpen(terminal, (startedAt) => timing('terminal.raster', startedAt, sessionId));
    let disposed = false;
    // WebGL while it shows, within the page's budget; else, or once WebGL fails, xterm's DOM renderer. Its element
    // says which, for tests and a look in DevTools. The two size cells differently (the DOM renderer to the glyph's
    // fractional width, WebGL to whole device pixels), so a change of renderer refits the terminal, which resizes the
    // session to the columns that now fit: only while it shows, so a pane out of view never resizes its session (each
    // resize redraws the agent's screen). It refits as it comes back into view, if its renderer changed meanwhile.
    const xterm = terminal.element!;
    xterm.dataset.renderer = 'dom';
    // Making a WebGL renderer (its context, shaders and atlas) is timed, for the benchmark.
    const gpuTerminal = {
      loadAddon(addon: Parameters<Terminal['loadAddon']>[0]) {
        const startedAt = performance.now();
        terminal.loadAddon(addon);
        timing('terminal.gpu', startedAt, sessionId);
      },
    };
    let shown = false;
    let everShown = false;
    // Out of view it waits: it settles as it comes back, so a zoom costs only the terminals that show.
    const stopHearingBoard = onBoardSettled(() => {
      if (shown) sharp.settle();
    });
    const seat = gpu().seat(gpuTerminal, (renderer) => {
      xterm.dataset.renderer = renderer;
      sharp.setRenderer(renderer);
      if (shown && !disposed && element.isConnected) fit.fit();
    });
    const show = (now: boolean) => {
      shown = now;
      everShown ||= now;
      seat.setShown(now);
      if (!now || disposed || !element.isConnected) return;
      // Fits only if its cells changed while it was out of view: the same size resizes nothing.
      fit.fit();
      // The board may have zoomed while it was out of view.
      sharp.settle();
    };
    // Size the session to this pane before attaching, so the snapshot arrives laid out for it: only a pane laid out
    // on the screen. One hidden (a tab not showing) has no size of its own, and would shrink the session to
    // xterm's 80×24 under whichever window shows it; it sizes the session once it shows, as it refits.
    const laidOut = element.getClientRects().length > 0;
    // Shown at once if laid out, so it fits once, for the renderer it draws with; the observer follows from here.
    show(laidOut);
    fit.fit();
    // Not once parked: `unobserve` leaves an entry already queued, which would claim a WebGL context for it.
    const visibility = new IntersectionObserver((entries) => {
      if (inPane) show(entries.at(-1)!.isIntersecting);
    });
    visibility.observe(element);
    const focusIn = () => seat.setFocused(true);
    const focusOut = () => seat.setFocused(false);
    // The addon waits seconds for a lost context to come back, drawing nothing; the canvas's own event goes back to the
    // DOM renderer at once. It doesn't bubble, so it is caught on the way down.
    const contextLost = () => seat.contextLost();
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    element.addEventListener('webglcontextlost', contextLost, true);
    timing('terminal.open', mountedAt, sessionId);

    let exited = false;
    let detach: (() => void) | undefined;
    // Measured once parsed: a parked terminal may have grown past the budget, a snapshot most of all.
    const wrote = () => {
      if (!inPane) kept.grew();
    };
    void (laidOut ? api.resize(sessionId, { cols: terminal.cols, rows: terminal.rows }).catch(() => {}) : Promise.resolve())
      .then(() => {
        if (disposed) return;
        const attaching = performance.now();
        const listen = (event: Parameters<Parameters<typeof api.attach>[1]>[0]) => {
          switch (event.type) {
            case 'session.snapshot': {
              terminal.reset();
              // How long it fills in, from the snapshot arriving to its last byte parsed: each frame between shows it part drawn.
              const arrived = performance.now();
              terminal.write(event.data, () => {
                timing('terminal.snapshot', attaching, { sessionId, bytes: event.data.length });
                timing('terminal.fill', arrived, { sessionId, renderer: terminal.element?.dataset.renderer });
                wrote();
              });
              status({ state: 'attached' });
              break;
            }
            case 'session.output':
              terminal.write(event.data, keep ? wrote : undefined);
              break;
            case 'session.exited':
              exited = true;
              status({ state: 'exited', ended: event.session });
              if (keep) kept.forget(sessionId, 'ended');
              break;
            case 'session.detached':
              if (!exited) status({ state: 'detached' });
              if (keep) kept.forget(sessionId, 'disconnected');
              break;
            case 'session.attachFailed':
              status({ state: 'unavailable', problem: event.message });
              if (keep) kept.forget(sessionId, 'disconnected');
              break;
          }
        };
        // Kept, it holds its connection while the agents around it keep changing, so it hears only its stream.
        detach = keep ? api.attach(sessionId, listen, { streamOnly: true }) : api.attach(sessionId, listen);
      });
    // xterm answers an agent's terminal queries by itself: only a terminal in a pane does, not a parked one as well.
    const input = terminal.onData((data) => {
      if (inPane) api.write(sessionId, data);
    });
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
    const resize = terminal.onResize((size) => {
      // Each resize redraws the agent's screen: counted, for the benchmark.
      timing('terminal.resize', performance.now(), { sessionId, ...size });
      void api.resize(sessionId, size).catch(() => {});
    });
    // Throttled: dragging a window's edge resizes the element every frame, and each new size resizes the session.
    // A kept terminal out of every pane has no size: it keeps the session's until it shows again.
    const refit = throttled(() => {
      if (!element.isConnected) return;
      fit.fit();
      sharp.settle();
    }, REFIT_INTERVAL_MS);
    const observer = new ResizeObserver(refit.call);
    observer.observe(element);
    if (focusedRef.current && autoFocusRef.current) terminal.focus();

    const dispose = () => {
      disposed = true;
      themeChange.disconnect();
      resized();
      element.removeEventListener('keydown', keyDown, true);
      element.removeEventListener('focusin', focusIn);
      element.removeEventListener('focusout', focusOut);
      element.removeEventListener('webglcontextlost', contextLost, true);
      visibility.disconnect();
      stopHearingBoard();
      seat.dispose();
      sharp.dispose();
      observer.disconnect();
      refit.cancel();
      input.dispose();
      links.dispose();
      resize.dispose();
      detach?.();
      terminal.dispose();
      if (keep) element.remove();
    };
    if (!keep) {
      return () => {
        terminalRef.current = null;
        dispose();
      };
    }
    const entry: KeptTerminal = {
      terminal,
      startedAt,
      everShown: () => everShown,
      bytes: () => terminalBytes({ rows: terminal.buffer.normal.length, cols: terminal.cols }),
      dispose(reason) {
        dispose();
        timing('terminal.letGo', performance.now(), { sessionId, reason });
      },
      enter(next, bound) {
        inPane = true;
        Object.assign(binding, bound);
        next.appendChild(element);
        // Asked before it fits to the new pane, whose resize would answer the question.
        const { cols, rows } = terminal;
        const sameSize = api.list().then(
          (sessions) => {
            const session = sessions.find((each) => each.id === sessionId);
            return session === undefined || (session.cols === cols && session.rows === rows);
          },
          () => true,
        );
        // Its renderer first, so it fits once for it; the observer's first report corrects a pane mounted out of view.
        show(element.getClientRects().length > 0);
        visibility.observe(element);
        return { status: lastStatus, sameSize };
      },
      leave() {
        inPane = false;
        element.remove();
        visibility.unobserve(element);
        Object.assign(binding, NO_PANE);
        seat.setFocused(false);
        show(false);
      },
    };
    kept.add(sessionId, entry);
    letGoWhenTurnedOff();
    return () => {
      terminalRef.current = null;
      park(sessionId, entry);
    };
  }, [sessionId, startedAt, rebuilds]);

  // A pinch reaches Chromium as a wheel with Ctrl. On the pane, which stays as a kept terminal moves, and takes one over
  // its padding too.
  useEffect(() => {
    const pane = container.current!;
    const wheel = (event: WheelEvent) => {
      const terminal = terminalRef.current;
      if (!event.ctrlKey || terminal === null) return;
      event.preventDefault();
      setFontSize((chosenFontSize() ?? terminal.options.fontSize!) - event.deltaY * PINCH_RATE);
    };
    pane.addEventListener('wheel', wheel, { passive: false });
    return () => pane.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (focused && (mounted.current || autoFocusRef.current)) terminalRef.current?.focus();
    mounted.current = true;
  }, [focused]);

  /**
   * An image on the clipboard goes to the agent as a file path, as a dropped file does: it is kept where the agent can
   * read it and its path typed at the prompt, one paste per image (a harness attaches only a lone path). Caught before
   * xterm, which pastes only text. A paste with text is left to xterm.
   */
  const pasteImage = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = pastedImages(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const terminal = terminalRef.current;
    // The pane clears its ref as it unmounts or parks the terminal.
    const alive = () => terminal !== null && terminalRef.current === terminal;
    void keepPastedImages(files)
      .then((paths) => {
        if (alive()) for (const path of paths) terminal!.paste(`${path} `);
      })
      .catch((problem: unknown) => {
        if (alive()) terminal!.write(`\r\n[could not paste the image: ${ipcErrorMessage(problem)}]\r\n`);
      });
  };

  return <div ref={container} className="terminal-pane nowheel" data-testid="session-terminal" onPasteCapture={pasteImage} />;
}

/**
 * A User Timing measure from `start` to now, for profiles and the rendering benchmark (e2e/render-bench.spec.ts): a
 * terminal's mount, its open and fit, its snapshot from attaching to parsed, and its fill from the snapshot arriving to
 * parsed. Cleared as soon as it is written, so the
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
