import { describe, expect, it, vi } from 'vitest';
import type { IBufferCell, Terminal } from '@xterm/xterm';
import { fillStrip, stripColour, type ThemeColours } from './terminal-strip-fill';

const THEME: ThemeColours = {
  background: { css: '#1b1a18' },
  foreground: { css: '#e6e1d6' },
  ansi: Array.from({ length: 256 }, (_, i) => ({ css: `ansi-${i}` })),
};

type Side = 'default' | 'palette' | 'rgb';
const cell = (bg: Side, fg: Side, colour: { bg?: number; fg?: number } = {}, inverse = false) =>
  ({
    isBgDefault: () => bg === 'default',
    isBgPalette: () => bg === 'palette',
    isBgRGB: () => bg === 'rgb',
    getBgColor: () => colour.bg ?? -1,
    isFgDefault: () => fg === 'default',
    isFgPalette: () => fg === 'palette',
    isFgRGB: () => fg === 'rgb',
    getFgColor: () => colour.fg ?? -1,
    isInverse: () => (inverse ? 1 : 0),
  }) as unknown as IBufferCell;

describe('stripColour', () => {
  it('is the theme background for a plain cell, and for a line past the end of the buffer', () => {
    expect(stripColour(cell('default', 'default'), THEME)).toBe('#1b1a18');
    expect(stripColour(undefined, THEME)).toBe('#1b1a18');
  });

  it('is the 24-bit background of a coloured cell', () => {
    expect(stripColour(cell('rgb', 'default', { bg: 0x373737 }), THEME)).toBe('#373737');
    expect(stripColour(cell('rgb', 'default', { bg: 0x00000a }), THEME)).toBe('#00000a');
  });

  it("is the theme's colour for a palette background, in the 16 and past them", () => {
    expect(stripColour(cell('palette', 'default', { bg: 4 }), THEME)).toBe('ansi-4');
    expect(stripColour(cell('palette', 'default', { bg: 240 }), THEME)).toBe('ansi-240');
  });

  it('is the foreground of an inverse cell, as a status bar draws', () => {
    expect(stripColour(cell('default', 'default', {}, true), THEME)).toBe('#e6e1d6');
    expect(stripColour(cell('default', 'rgb', { fg: 0xff0000 }, true), THEME)).toBe('#ff0000');
    expect(stripColour(cell('default', 'palette', { fg: 2 }, true), THEME)).toBe('ansi-2');
  });
});

describe('fillStrip', () => {
  /** A terminal of three rows, the last cell of each in `lastColours` (palette indices), and a screen whose canvases record what they paint. */
  function fake(lastColours: number[]) {
    const painted: string[][] = [];
    const canvases: { className: string; width: number; height: number; style: Record<string, string>; removed: boolean }[] = [];
    const document = {
      createElement: () => {
        const rows: string[] = [];
        painted.push(rows);
        const context = {
          fillStyle: '',
          fillRect(_x: number, y: number) {
            rows[y] = context.fillStyle;
          },
        };
        const canvas = {
          className: '',
          width: 0,
          height: 0,
          removed: false,
          style: { setProperty(name: string, value: string) { (this as unknown as Record<string, string>)[name] = value; } } as unknown as Record<string, string>,
          getContext: () => context,
          remove() {
            canvas.removed = true;
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    };
    const screen = { ownerDocument: document, appendChild: vi.fn() };
    let onRender: ((range: { start: number; end: number }) => void) | undefined;
    const subscription = { dispose: vi.fn() };
    const line = (row: number) => ({ getCell: () => cell('palette', 'default', { bg: lastColours[row] }) });
    const terminal = {
      cols: 80,
      rows: 3,
      buffer: { active: { viewportY: 0, getNullCell: () => ({}), getLine: (row: number) => line(row) } },
      onRender: (listener: typeof onRender) => {
        onRender = listener;
        return subscription;
      },
    };
    const fill = fillStrip(terminal as unknown as Terminal, screen as unknown as HTMLElement, () => THEME);
    return { fill, canvases, painted, screen, subscription, lastColours, render: (start: number, end: number) => onRender?.({ start, end }) };
  }

  it('puts a canvas of one pixel per row beside the grid, in each row\'s last colour, stretched over the strip', () => {
    const { fill, canvases, painted, screen } = fake([1, 2, 3]);
    fill.place({ left: 600, width: 1.9, height: 450 });
    expect(screen.appendChild).toHaveBeenCalledTimes(1);
    const [strip] = canvases;
    expect(strip).toMatchObject({ className: 'xterm-strip-fill-layer', width: 1, height: 3 });
    expect(strip!.style).toMatchObject({ display: 'block', left: '600px', width: '1.9px', height: '450px', imageRendering: 'pixelated' });
    expect(painted[0]).toEqual(['ansi-1', 'ansi-2', 'ansi-3']);
  });

  it('repaints the rows a redraw covers', () => {
    const { fill, painted, lastColours, render } = fake([1, 2, 3]);
    fill.place({ left: 600, width: 1.9, height: 450 });
    lastColours[1] = 9;
    lastColours[2] = 9;
    render(1, 1);
    expect(painted[0]).toEqual(['ansi-1', 'ansi-9', 'ansi-3']);
  });

  it('hides the strip, and paints nothing, where there is none to fill', () => {
    const { fill, canvases, painted, lastColours, render } = fake([1, 2, 3]);
    fill.place({ left: 600, width: 0, height: 450 });
    expect(canvases).toEqual([]);
    fill.place({ left: 600, width: 1.9, height: 450 });
    fill.place({ left: 600, width: 0, height: 450 });
    expect(canvases[0]!.style.display).toBe('none');
    lastColours[0] = 9;
    render(0, 2);
    expect(painted[0]).toEqual(['ansi-1', 'ansi-2', 'ansi-3']);
  });

  it('once disposed, removes its canvas and stops following redraws', () => {
    const { fill, canvases, subscription } = fake([1, 2, 3]);
    fill.place({ left: 600, width: 1.9, height: 450 });
    fill.dispose();
    expect(canvases[0]!.removed).toBe(true);
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
  });
});
