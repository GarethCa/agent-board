// Keeps a WebGL terminal sharp under the board's zoom. xterm's WebGL renderer draws to a canvas at layout size × device
// pixel ratio, which the board's CSS transform then stretches, so its text blurs at any zoom but 100%. The DOM renderer
// has no such problem: the browser rasterises its text at the final scale.
//
// So once the zoom settles, the canvas is redrawn at the size it has on the screen, each of its pixels one device pixel.
// Only the device side of xterm's dimensions moves. The CSS side stays at the size for 100%, so fitting, columns and rows
// never depend on the zoom, and the session is never resized by it (each resize redraws the agent's screen). A transform
// on the terminal's screen takes up what remains: cells hold whole device pixels, so a zoomed grid falls a little short of
// its layout size (`terminal-strip-fill.ts` carries its rows' colours across the difference), and the screen's corner moves onto a whole device pixel. The mouse mapping reads the screen's on-screen
// box (`zoomed-mouse.ts`), so it follows the transform by itself.
//
// While the zoom moves the canvas is stretched as before, as redrawing every frame would cost far more than it shows.
import type { Terminal } from '@xterm/xterm';
import { fillStrip, type StripBox, type StripFill, type ThemeColours } from './terminal-strip-fill';

/**
 * Below this zoom text is past reading, and the canvas stops shrinking: the transform scales it down the rest of the way.
 * The board's own minimum, 0.05, would leave cells of no pixels.
 */
const MIN_RASTER_ZOOM = 0.25;
/** The most pixels a terminal's canvas holds, about 60 MB at four bytes each: past it, the transform scales it up the rest of the way. */
const MAX_RASTER_PIXELS = 16_000_000;

/** A cell at a zoom measured from a box's float size can land just under the whole number it should be: this keeps `floor` from losing a pixel to it. */
const FLOOR_EPSILON = 1e-3;

/**
 * The most of a cell rounding down may lose. Past it the cell takes the next whole pixel, and the transform squeezes the
 * canvas: about 3% at the zooms people use, more at the low end where text is barely readable anyway (up to about 26%).
 * That is softer than one pixel to a pixel, but far less visible than text and a grid that much smaller. At a ratio of 2 it matters only at free zooms; at a ratio of 1, where a pixel is much of a cell, at ordinary ones.
 */
const MAX_CELL_LOSS = 0.1;

/** The fewest device pixels whole-pixel cells must lose across a row for the strip beside the grid to be shown. */
const MIN_STRIP_LOSS = 0.5;

/** The whole pixels a cell of `exact` pixels holds: rounded down, unless that loses too much of it. */
function wholeCell(exact: number): number {
  const floor = Math.max(1, Math.floor(exact + FLOOR_EPSILON));
  return (exact - floor) / exact > MAX_CELL_LOSS ? floor + 1 : floor;
}

export interface RasterInput {
  /** The measured character, in CSS pixels. */
  charWidth: number;
  charHeight: number;
  lineHeight: number;
  letterSpacing: number;
  /** The window's device pixel ratio. */
  dpr: number;
  /** The scale the terminal is under on the screen: 1 where nothing scales it. */
  zoom: number;
  cols: number;
  rows: number;
}

/** A terminal's canvas and cells for a zoom, in the names of xterm's render dimensions. */
export interface Raster {
  /** The device pixel ratio the glyphs are drawn at, so they keep their proportion to their cells. */
  devicePixelRatio: number;
  device: {
    char: { width: number; height: number; top: number; left: number };
    cell: { width: number; height: number };
    canvas: { width: number; height: number };
  };
  /** What layout sees, the same at every zoom. */
  css: {
    cell: { width: number; height: number };
    canvas: { width: number; height: number };
  };
  /** The scale on the screen element that lands each canvas pixel on one device pixel. */
  screenScale: { x: number; y: number };
  /** The strip right of the grid that its whole-pixel cells leave, in the screen's own CSS pixels, for `fillStrip` to carry the rows on to their layout width. */
  strip: StripBox;
}

/**
 * The canvas and cells for a zoom. At 100% the cells are those xterm's own renderer computes; zoomed, they are as many
 * whole device pixels as fit in the zoomed cell (see `MAX_CELL_LOSS`), so the grid never runs past its layout size.
 */
export function raster({ charWidth, charHeight, lineHeight, letterSpacing, dpr, zoom, cols, rows }: RasterInput): Raster {
  const spacing = Math.round(letterSpacing);
  const baseCellWidth = Math.floor(charWidth * dpr) + spacing;
  const baseCellHeight = Math.floor(Math.ceil(charHeight * dpr) * lineHeight);
  const largest = Math.sqrt(MAX_RASTER_PIXELS / Math.max(1, cols * baseCellWidth * rows * baseCellHeight));
  const scale = Math.max(MIN_RASTER_ZOOM, Math.min(zoom, largest));
  const cellWidth = wholeCell(baseCellWidth * scale);
  const cellHeight = wholeCell(baseCellHeight * scale);
  const charHeightDevice = lineHeight === 1 ? cellHeight : Math.max(1, Math.floor(cellHeight / lineHeight));
  const canvas = { width: cols * cellWidth, height: rows * cellHeight };
  const css = {
    cell: { width: baseCellWidth / dpr, height: baseCellHeight / dpr },
    canvas: { width: Math.round((cols * baseCellWidth) / dpr), height: Math.round((rows * baseCellHeight) / dpr) },
  };
  const screenScale = {
    x: (cols * Math.min(cellWidth, baseCellWidth * scale)) / (dpr * scale * css.canvas.width),
    y: (rows * Math.min(cellHeight, baseCellHeight * scale)) / (dpr * scale * css.canvas.height),
  };
  // The strip takes up what the transform drew in. It is shown only when whole-pixel cells lose half a device pixel or
  // more on the screen: what is left at 100% (or wherever the cells are whole) is `css.canvas`'s own rounding.
  const lost = (cols * (baseCellWidth * scale - Math.min(cellWidth, baseCellWidth * scale)) * zoom) / scale;
  const strip = lost < MIN_STRIP_LOSS ? 0 : css.canvas.width / screenScale.x - css.canvas.width;
  return {
    devicePixelRatio: dpr * Math.min(cellWidth / baseCellWidth, cellHeight / baseCellHeight),
    device: {
      char: { width: Math.max(1, cellWidth - spacing), height: charHeightDevice, top: lineHeight === 1 ? 0 : Math.round((cellHeight - charHeightDevice) / 2), left: Math.floor(letterSpacing / 2) },
      cell: { width: cellWidth, height: cellHeight },
      canvas,
    },
    css,
    // A cell rounded up is shown at its exact size, so the grid never runs past its layout size.
    screenScale,
    strip: { left: css.canvas.width, width: strip, height: css.canvas.height },
  };
}

/** How far, in the element's own CSS pixels under `zoom`, to move a corner at on-screen `position` onto a whole device pixel. */
export function snapOffset(position: number, dpr: number, zoom: number): number {
  return (Math.round(position * dpr) / dpr - position) / zoom;
}

/** The scale an element is under, from its on-screen size and its exact layout size (not `offsetWidth`, which is rounded): 1 if it has neither. */
export function screenZoom(onScreenWidth: number, layoutWidth: number): number {
  return onScreenWidth > 0 && layoutWidth > 0 ? onScreenWidth / layoutWidth : 1;
}

/** The slices of xterm's (private) services this reaches into; xterm is pinned, and terminal-sharpness.test.ts looks for these names in its bundles. */
interface BrowserService {
  readonly window: Window & typeof globalThis;
  onDprChange(listener: () => void): { dispose(): void };
}

interface CharSizeService {
  readonly width: number;
  readonly height: number;
}

interface WebglRenderer {
  dimensions: { device: Raster['device']; css: Raster['css'] };
  _devicePixelRatio: number;
  _updateDimensions(): void;
  _setCanvasDevicePixelDimensions(width: number, height: number): void;
  renderRows(start: number, end: number): void;
}

interface RenderService {
  _renderer: { value?: Partial<WebglRenderer> };
  handleResize(cols: number, rows: number): void;
  handleDevicePixelRatioChange(): void;
}

interface Core {
  _coreBrowserService?: BrowserService;
  _charSizeService?: CharSizeService;
  _renderService?: RenderService;
  _themeService?: { readonly colors: ThemeColours };
  screenElement?: HTMLElement;
}

export interface Sharpener {
  /** The terminal's renderer changed: on WebGL it starts following the zoom, and on the DOM renderer it stops. */
  setRenderer(renderer: 'webgl' | 'dom'): void;
  /** The terminal is where it will stay, for now: draws for its scale and moves onto the device pixels. */
  settle(): void;
  dispose(): void;
}

/** How long a tile stays put before its terminal moves onto the device pixels again. */
const TILE_MOVE_SETTLE_MS = 100;
/** What an animation must touch to change what a terminal measures. */
const RESIZING = ['scale', 'transform', 'width', 'height'];
const ARRIVALS = ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'];

const NO_SHARPENER: Sharpener = { setRenderer() {}, settle() {}, dispose() {} };

function isWebgl(renderer: Partial<WebglRenderer> | undefined): renderer is WebglRenderer {
  return renderer?._updateDimensions !== undefined && renderer._setCanvasDevicePixelDimensions !== undefined && renderer.renderRows !== undefined;
}

/** Keeps `terminal`, which must be open, sharp while it draws with WebGL. `onRedrawn` hears each redraw and when it started, for the benchmark. */
export function sharpen(terminal: Terminal, onRedrawn?: (startedAt: number) => void): Sharpener {
  const core = (terminal as unknown as { _core?: Core })._core;
  const browser = core?._coreBrowserService;
  const charSize = core?._charSizeService;
  const render = core?._renderService;
  const screen = core?.screenElement;
  if (browser === undefined || charSize === undefined || render === undefined || screen === undefined) {
    // xterm moved its internals (an upgrade): its text blurs under zoom again. terminal-sharpness.test.ts pins the shape.
    console.warn('terminal-sharpness: xterm has no services to draw through; terminals are not sharp under zoom');
    return NO_SHARPENER;
  }

  /** The glyphs' scale, which every part of the WebGL renderer reads through the service's `dpr`. Nothing else moves it. */
  let glyphScale = 1;
  // An own property over the service's getter, read live, so a move to another display still counts.
  Object.defineProperty(browser, 'dpr', { configurable: true, get: () => browser.window.devicePixelRatio * glyphScale });

  const page = browser.window.document;
  let renderer: WebglRenderer | undefined;
  /** The zoom the canvas is drawn for. */
  let zoom = 1;
  let offset = { x: 0, y: 0 };
  let current: Raster | undefined;
  let fill: StripFill | undefined;

  const place = () => {
    if (current === undefined) return;
    const { x, y } = current.screenScale;
    screen.style.transformOrigin = '0 0';
    screen.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${x}, ${y})`;
    fill?.place(current.strip);
  };

  const compute = () =>
    raster({
      charWidth: charSize.width,
      charHeight: charSize.height,
      lineHeight: terminal.options.lineHeight ?? 1,
      letterSpacing: terminal.options.letterSpacing ?? 0,
      dpr: browser.window.devicePixelRatio,
      zoom,
      cols: terminal.cols,
      rows: terminal.rows,
    });

  /** Takes over the WebGL renderer's dimensions, so it draws for the zoom. */
  const adopt = (webgl: WebglRenderer) => {
    webgl._updateDimensions = () => {
      if (!charSize.width || !charSize.height) return;
      current = compute();
      glyphScale = current.devicePixelRatio / browser.window.devicePixelRatio;
      webgl._devicePixelRatio = current.devicePixelRatio;
      Object.assign(webgl.dimensions.device.char, current.device.char);
      Object.assign(webgl.dimensions.device.cell, current.device.cell);
      Object.assign(webgl.dimensions.device.canvas, current.device.canvas);
      Object.assign(webgl.dimensions.css.cell, current.css.cell);
      Object.assign(webgl.dimensions.css.canvas, current.css.canvas);
      place();
    };
    // Its observer would set the canvas to its layout size × the device pixel ratio, undoing the zoom, and a pixel off
    // the grid at an odd width. The transform does what the observer was for, for any ratio.
    webgl._setCanvasDevicePixelDimensions = () => {};
  };

  /** Draws the canvas for the zoom now: changing its size clears it, and a frame shown before the next draw would flash. */
  const redraw = () => {
    const startedAt = performance.now();
    render.handleResize(terminal.cols, terminal.rows);
    // Past xterm's hold on a synchronized frame, on purpose: the resize has cleared the canvas, and a frame half updated beats a blank one.
    renderer?.renderRows(0, terminal.rows - 1);
    onRedrawn?.(startedAt);
  };

  /** Whether something around it is changing its scale or size, whose end settles it: a scale read now would be a passing one. A pulse of its shadow doesn't count. */
  const moving = () =>
    page.getAnimations().some((each) => {
      const effect = each.effect as KeyframeEffect | null;
      if (each.playState !== 'running' || effect?.target?.contains(screen) !== true || effect.getComputedTiming().iterations === Infinity) return false;
      return effect.getKeyframes().some((frame) => RESIZING.some((property) => property in frame));
    });

  const settle = () => {
    if (renderer === undefined || !screen.isConnected) return;
    const xterm = terminal.element;
    if (xterm === undefined || xterm.offsetWidth === 0) return;
    watchTile();
    if (moving()) return;
    const scale = screenZoom(xterm.getBoundingClientRect().width, parseFloat(browser.window.getComputedStyle(xterm).width));
    const dpr = browser.window.devicePixelRatio;
    // Where the screen would sit with no offset of its own.
    const box = screen.getBoundingClientRect();
    offset = { x: snapOffset(box.left - offset.x * scale, dpr, scale), y: snapOffset(box.top - offset.y * scale, dpr, scale) };
    const before = current;
    zoom = scale;
    const next = compute();
    if (before === undefined || next.device.cell.width !== before.device.cell.width || next.device.cell.height !== before.device.cell.height) {
      redraw();
    } else {
      // The same pixels for a zoom that hardly moved: only the transform changes.
      current = next;
      place();
    }
  };

  // A tile moved any way at all (dragged, arranged, undone, pushed aside) leaves the screen's corner off the device pixels.
  // A session window isn't watched: whole CSS pixels stay on the device pixels at a ratio of 1 or 2, though not at, say, 1.25.
  let watched: Element | null = null;
  let afterMove: ReturnType<typeof setTimeout> | undefined;
  const tileMoves = new browser.window.MutationObserver(() => {
    clearTimeout(afterMove);
    afterMove = setTimeout(settle, TILE_MOVE_SETTLE_MS);
  });
  function watchTile(): void {
    const tile = terminal.element?.closest('.react-flow__node') ?? null;
    if (tile === watched) return;
    tileMoves.disconnect();
    watched = tile;
    if (tile !== null) tileMoves.observe(tile, { attributes: true, attributeFilter: ['style'] });
  }

  const dprChange = browser.onDprChange(settle);
  // Something around it finished moving, or was stopped: a window opening from a slightly smaller scale, tiles arranging themselves.
  const arrived = (event: Event) => {
    if (event.target instanceof Node && event.target.contains(screen)) settle();
  };
  for (const name of ARRIVALS) page.addEventListener(name, arrived, true);

  return {
    setRenderer(next) {
      if (next === 'dom') {
        renderer = undefined;
        current = undefined;
        glyphScale = 1;
        zoom = 1;
        offset = { x: 0, y: 0 };
        fill?.dispose();
        fill = undefined;
        screen.style.removeProperty('transform');
        screen.style.removeProperty('transform-origin');
        // The DOM renderer took its sizes as it was made, through the scale it no longer has.
        render.handleDevicePixelRatioChange();
        return;
      }
      const webgl = render._renderer.value;
      if (!isWebgl(webgl)) {
        console.warn('terminal-sharpness: xterm has no WebGL renderer to draw through; terminals are not sharp under zoom');
        return;
      }
      renderer = webgl;
      const theme = core?._themeService;
      if (fill === undefined && theme !== undefined) fill = fillStrip(terminal, screen, () => theme.colors);
      adopt(webgl);
      settle();
    },
    settle,
    dispose() {
      dprChange.dispose();
      for (const name of ARRIVALS) page.removeEventListener(name, arrived, true);
      tileMoves.disconnect();
      clearTimeout(afterMove);
      fill?.dispose();
      renderer = undefined;
    },
  };
}

const settledListeners = new Set<() => void>();

/** The board's viewport has come to rest: every terminal on it draws for the new zoom. */
export function boardSettled(): void {
  for (const listener of settledListeners) listener();
}

/** Hears when the board's viewport comes to rest. Returns how to stop. */
export function onBoardSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}
