import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Terminal } from '@xterm/xterm';
import { boardSettled, onBoardSettled, raster, screenZoom, sharpen, snapOffset, type RasterInput } from './terminal-sharpness';

// The mono's measure at 13 px, as Chromium gives it.
const INPUT: RasterInput = { charWidth: 7.8, charHeight: 15, lineHeight: 1, letterSpacing: 0, dpr: 2, zoom: 1, cols: 115, rows: 32 };

/** How many device pixels the canvas covers on the screen, per canvas pixel, once its screen has the transform. */
const coverage = ({ dpr, zoom }: RasterInput, out: ReturnType<typeof raster>) => ({
  x: (out.css.canvas.width * out.screenScale.x * dpr * zoom) / out.device.canvas.width,
  y: (out.css.canvas.height * out.screenScale.y * dpr * zoom) / out.device.canvas.height,
});

describe('raster', () => {
  it('at 100% has the cells xterm itself computes, whole device pixels of the measured character', () => {
    const out = raster(INPUT);
    expect(out.device.cell).toEqual({ width: 15, height: 30 });
    expect(out.device.char).toEqual({ width: 15, height: 30, top: 0, left: 0 });
    expect(out.device.canvas).toEqual({ width: 115 * 15, height: 32 * 30 });
    expect(out.css.cell).toEqual({ width: 7.5, height: 15 });
    expect(out.devicePixelRatio).toBe(2);
  });

  it.each([0.4, 0.5, 0.58, 0.69, 0.83, 1, 1.2, 1.44, 1.73, 2])('at a zoom of %d keeps what layout sees, so no zoom ever resizes the session', (zoom) => {
    expect(raster({ ...INPUT, zoom }).css).toEqual(raster(INPUT).css);
  });

  it.each([0.4, 0.5, 0.58, 0.69, 0.83, 1, 1.2, 1.44, 1.73, 2])('at a zoom of %d lands each canvas pixel on one device pixel', (zoom) => {
    const input = { ...INPUT, zoom };
    const { x, y } = coverage(input, raster(input));
    expect(x).toBeCloseTo(1, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('lands each canvas pixel on one device pixel at an odd column count, where half of an odd width rounds up', () => {
    const out = raster(INPUT);
    expect(out.device.canvas.width % 2).toBe(1);
    expect(out.css.canvas.width).toBe(863);
    expect(coverage(INPUT, out).x).toBeCloseTo(1, 10);
  });

  it.each([0.4, 0.58, 0.83, 1.06, 1.44, 1.73, 2])('at a zoom of %d never runs past the layout size, and falls short by under a device pixel a cell', (zoom) => {
    const out = raster({ ...INPUT, zoom });
    const exact = { width: 15 * zoom, height: 30 * zoom };
    expect(out.device.cell.width).toBeLessThanOrEqual(exact.width);
    expect(out.device.cell.height).toBeLessThanOrEqual(exact.height);
    expect(exact.width - out.device.cell.width).toBeLessThan(1);
    expect(exact.height - out.device.cell.height).toBeLessThan(1);
    expect(out.screenScale.x).toBeLessThanOrEqual(1);
    expect(out.screenScale.y).toBeLessThanOrEqual(1);
  });

  it('keeps the glyphs in proportion to the cells, and no taller or wider than they fit', () => {
    const out = raster({ ...INPUT, zoom: 1.44 });
    // 21.6 × 43.2 device pixels, held as 21 × 43: the width is the tighter.
    expect(out.device.cell).toEqual({ width: 21, height: 43 });
    expect(out.devicePixelRatio).toBeCloseTo((2 * 21) / 15, 10);
  });

  it('does not lose a pixel to a zoom measured from a float box', () => {
    expect(raster({ ...INPUT, zoom: 1.1999999 }).device.cell.width).toBe(18);
  });

  it('stops shrinking at very low zoom, where text is past reading, leaving the rest to the transform', () => {
    const input = { ...INPUT, zoom: 0.05 };
    const out = raster(input);
    expect(out.device.cell.width).toBeGreaterThanOrEqual(3);
    // Each canvas pixel is more than one device pixel's worth of the zoomed board: scaled down, on purpose.
    expect((out.css.canvas.width * out.screenScale.x * input.dpr * input.zoom) / out.device.canvas.width).toBeCloseTo((0.05 / 0.25) * (3.75 / 4), 10);
  });

  it('caps a huge canvas, leaving the rest of the zoom to the transform', () => {
    const out = raster({ ...INPUT, cols: 400, rows: 120, zoom: 2 });
    expect(out.device.canvas.width * out.device.canvas.height).toBeLessThanOrEqual(16_000_000);
  });

  it('keeps letter spacing and line height as xterm does', () => {
    const out = raster({ ...INPUT, lineHeight: 1.2, letterSpacing: 2 });
    expect(out.device.cell).toEqual({ width: 17, height: 36 });
    expect(out.device.char).toEqual({ width: 15, height: 30, top: 3, left: 1 });
  });

  it('takes the next pixel up when rounding down would lose over a tenth of a cell, shown at the exact size', () => {
    // At a ratio of 1 a cell of 7 is 5.81 at 0.83: 5 would lose 14%.
    const input = { ...INPUT, dpr: 1, zoom: 0.83 };
    const out = raster(input);
    expect(out.device.cell.width).toBe(6);
    // Shown at the exact 5.81 pixels a cell: the whole grid's 115 × 7 CSS pixels under the zoom.
    expect(out.css.canvas.width * out.screenScale.x).toBeCloseTo(115 * 7, 6);
    // Its height, 15 × 0.83 = 12.45, stays on the pixels.
    expect(out.device.cell.height).toBe(12);
    for (const zoom of [0.3, 0.4, 0.48, 0.571, 0.69, 0.83, 0.856, 1.1, 1.2]) {
      const { device, screenScale } = raster({ ...INPUT, dpr: 1, zoom });
      expect((7 * zoom - Math.min(device.cell.width, 7 * zoom)) / (7 * zoom)).toBeLessThanOrEqual(0.1);
      expect(screenScale.x).toBeLessThan(1 + 1e-9);
      expect(screenScale.y).toBeLessThan(1 + 1e-9);
    }
  });

  it('holds at a fractional ratio and one above 2', () => {
    for (const dpr of [1.25, 1.5, 3]) {
      for (const zoom of [1, 1.44]) {
        const input = { ...INPUT, dpr, zoom };
        const { x, y } = coverage(input, raster(input));
        expect(x).toBeCloseTo(1, 10);
        expect(y).toBeCloseTo(1, 10);
      }
    }
  });
});

describe('snapOffset', () => {
  it('leaves a corner on a device pixel alone', () => {
    expect(snapOffset(100.5, 2, 1)).toBe(0);
  });

  it('moves a corner to the nearest device pixel, in the CSS pixels of the zoomed element', () => {
    // 97.6 CSS pixels is 195.2 device pixels, so 0.2 device pixels back: 0.1 on the screen, 0.1 / 1.2 in the element.
    expect(snapOffset(97.6, 2, 1.2)).toBeCloseTo(-0.1 / 1.2, 10);
  });
});

describe('screenZoom', () => {
  it('reads the scale off the on-screen and layout sizes', () => {
    expect(screenZoom(1242.72, 863)).toBeCloseTo(1.44, 10);
  });

  it('is 1 for an element with no size', () => {
    expect(screenZoom(0, 0)).toBe(1);
  });
});

describe('sharpen', () => {
  /** A terminal as far as the patch reaches, with a WebGL renderer that does what xterm's does with its dimensions. */
  function fake({ scale = 1.44, left = 97.6, top = 251.2 } = {}) {
    const style = { transform: '', transformOrigin: '', removeProperty(name: string) { (this as unknown as Record<string, string>)[name === 'transform' ? 'transform' : 'transformOrigin'] = ''; } };
    const box = { left, top };
    const screen = { style, isConnected: true, getBoundingClientRect: () => box };
    const size = { width: 863 * scale };
    const animations: unknown[] = [];
    const layout = { width: '863px' };
    const window = {
      devicePixelRatio: 2,
      document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getAnimations: () => animations },
      getComputedStyle: () => layout,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    };
    const dimensions = {
      device: { char: { width: 0, height: 0, top: 0, left: 0 }, cell: { width: 0, height: 0 }, canvas: { width: 0, height: 0 } },
      css: { cell: { width: 0, height: 0 }, canvas: { width: 0, height: 0 } },
    };
    const canvasWrites: [number, number][] = [];
    const webgl = {
      dimensions,
      _devicePixelRatio: 2,
      _updateDimensions: vi.fn(),
      _setCanvasDevicePixelDimensions: (w: number, h: number) => canvasWrites.push([w, h]),
      renderRows: vi.fn(),
    };
    const render = {
      _renderer: { value: webgl as unknown },
      handleResize: vi.fn(() => webgl._updateDimensions()),
      handleDevicePixelRatioChange: vi.fn(),
    };
    const browser = { window, onDprChange: vi.fn(() => ({ dispose: vi.fn() })) };
    const terminal = {
      cols: 115,
      rows: 32,
      options: {},
      element: { offsetWidth: 863, closest: () => null, getBoundingClientRect: () => size },
      _core: { _coreBrowserService: browser, _charSizeService: { width: 7.8, height: 15 }, _renderService: render, screenElement: screen },
    };
    return { terminal: terminal as unknown as Terminal, animations, screen, layout, webgl, render, browser, style, size, box, canvasWrites };
  }

  it('draws for the zoom through the WebGL renderer, with the layout unchanged, once it takes WebGL', () => {
    const { terminal, webgl, style, browser } = fake();
    sharpen(terminal).setRenderer('webgl');
    expect(webgl.dimensions.device.cell).toEqual({ width: 21, height: 43 });
    expect(webgl.dimensions.css.cell).toEqual({ width: 7.5, height: 15 });
    expect(webgl.renderRows).toHaveBeenCalledWith(0, 31);
    expect(style.transform).toMatch(/^translate\(.*\) scale\(.*\)$/);
    expect(style.transformOrigin).toBe('0 0');
    // The atlas and the glyphs read this.
    expect((browser as unknown as { dpr: number }).dpr).toBeCloseTo(2.8, 10);
  });

  it('reads the zoom against the exact layout width, not the rounded offsetWidth, so a fractional pane at 100% keeps its cells', () => {
    const { terminal, webgl, size, layout } = fake();
    (terminal.element as unknown as { offsetWidth: number }).offsetWidth = 501;
    layout.width = '500.5px';
    size.width = 500.5;
    sharpen(terminal).setRenderer('webgl');
    expect(webgl.dimensions.device.cell).toEqual({ width: 15, height: 30 });
  });

  it('draws nothing for the passing scale of an animation around it, and settles when it ends', () => {
    const { terminal, animations, screen, render, size } = fake();
    size.width = 863 * 0.985;
    animations.push({ playState: 'running', effect: { target: { contains: (node: unknown) => node === screen }, getComputedTiming: () => ({ iterations: 1 }), getKeyframes: () => [{ scale: '0.985' }] } });
    const sharp = sharpen(terminal);
    sharp.setRenderer('webgl');
    expect(render.handleResize).not.toHaveBeenCalled();
    animations.length = 0;
    size.width = 863;
    sharp.settle();
    expect(render.handleResize).toHaveBeenCalledTimes(1);
  });

  it('is not held up by an animation elsewhere, or one that never ends', () => {
    const { terminal, animations, screen, render } = fake();
    animations.push({ playState: 'running', effect: { target: { contains: () => false }, getComputedTiming: () => ({ iterations: 1 }), getKeyframes: () => [{ scale: '0.985' }] } });
    animations.push({ playState: 'running', effect: { target: { contains: (node: unknown) => node === screen }, getComputedTiming: () => ({ iterations: Infinity }), getKeyframes: () => [{ scale: '0.985' }] } });
    sharpen(terminal).setRenderer('webgl');
    expect(render.handleResize).toHaveBeenCalledTimes(1);
  });

  it('is not held up by an animation that only pulses a shadow', () => {
    const { terminal, animations, screen, render } = fake();
    animations.push({ playState: 'running', effect: { target: { contains: (node: unknown) => node === screen }, getComputedTiming: () => ({ iterations: 1 }), getKeyframes: () => [{ boxShadow: 'none' }] } });
    sharpen(terminal).setRenderer('webgl');
    expect(render.handleResize).toHaveBeenCalledTimes(1);
  });

  it('turns off the canvas observer that would undo it', () => {
    const { terminal, webgl, canvasWrites } = fake();
    sharpen(terminal).setRenderer('webgl');
    webgl._setCanvasDevicePixelDimensions(1726, 960);
    expect(canvasWrites).toEqual([]);
  });

  it('redraws for a new zoom, and only moves for a pan', () => {
    const { terminal, webgl, render, size, box, style } = fake();
    const sharp = sharpen(terminal);
    sharp.setRenderer('webgl');
    expect(render.handleResize).toHaveBeenCalledTimes(1);

    // Panned, a new position at the same zoom: the same pixels, moved.
    box.left = 120.3;
    const placed = style.transform;
    sharp.settle();
    expect(render.handleResize).toHaveBeenCalledTimes(1);
    expect(style.transform).not.toBe(placed);

    size.width = 863;
    sharp.settle();
    expect(render.handleResize).toHaveBeenCalledTimes(2);
    expect(webgl.dimensions.device.cell).toEqual({ width: 15, height: 30 });
  });

  it('measures where the screen would be without its own offset', () => {
    const { terminal, box, style } = fake({ scale: 1, left: 100.2, top: 50 });
    const sharp = sharpen(terminal);
    sharp.setRenderer('webgl');
    expect(style.transform).toContain('translate(-0.2');
    // The box now reads where the transform put it: settling again must not move it further.
    box.left = 100;
    sharp.settle();
    expect(style.transform).toContain('translate(-0.2');
  });

  it('on the DOM renderer gives everything back, and the renderer takes its true sizes', () => {
    const { terminal, render, style, browser } = fake();
    const sharp = sharpen(terminal);
    sharp.setRenderer('webgl');
    sharp.setRenderer('dom');
    expect(style.transform).toBe('');
    expect(style.transformOrigin).toBe('');
    expect((browser as unknown as { dpr: number }).dpr).toBe(2);
    expect(render.handleDevicePixelRatioChange).toHaveBeenCalledTimes(1);
    // Nothing to draw through until it has WebGL again.
    render.handleResize.mockClear();
    sharp.settle();
    expect(render.handleResize).not.toHaveBeenCalled();
  });

  it('settles when something around it finishes moving, and not for what moves elsewhere', () => {
    const { terminal, browser, render, size } = fake();
    const sharp = sharpen(terminal);
    sharp.setRenderer('webgl');
    size.width = 863;
    render.handleResize.mockClear();
    const listen = browser.window.document.addEventListener.mock.calls as unknown as [string, (event: unknown) => void][];
    const arrived = listen.find(([name]) => name === 'animationend')![1];
    // In the test's node environment there is no `Node` global: give it the one the listener reads.
    vi.stubGlobal('Node', class {});
    const around = Object.assign(new (globalThis as unknown as { Node: new () => object }).Node(), { contains: () => true });
    const elsewhere = Object.assign(new (globalThis as unknown as { Node: new () => object }).Node(), { contains: () => false });
    arrived({ target: elsewhere });
    expect(render.handleResize).not.toHaveBeenCalled();
    arrived({ target: around });
    expect(render.handleResize).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('warns loudly when xterm has no services to reach', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sharp = sharpen({} as Terminal);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal-sharpness'));
    sharp.setRenderer('webgl');
    sharp.settle();
    warn.mockRestore();
  });

  it('warns when the renderer it took is not the WebGL one it knows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { terminal, render } = fake();
    render._renderer.value = {};
    sharpen(terminal).setRenderer('webgl');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WebGL'));
    warn.mockRestore();
  });

  // The patch reaches into xterm's private fields. If an upgrade renames them this fails, not just the visual shots.
  it('still matches the shipped xterm and WebGL addon internals it patches', () => {
    const require = createRequire(import.meta.url);
    const xterm = readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
    for (const name of ['_core', '_coreBrowserService', '_charSizeService', '_renderService', '_renderer', 'screenElement', 'onDprChange', 'handleDevicePixelRatioChange', 'handleResize', 'dpr', 'devicePixelRatio']) expect(xterm, name).toContain(name);
    const addon = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8');
    for (const name of ['_updateDimensions', '_setCanvasDevicePixelDimensions', '_devicePixelRatio', 'renderRows', 'dimensions']) expect(addon, name).toContain(name);
  });
});

describe('board settling', () => {
  it('reaches each listener until it stops listening', () => {
    const heard = vi.fn();
    const stop = onBoardSettled(heard);
    boardSettled();
    stop();
    boardSettled();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
