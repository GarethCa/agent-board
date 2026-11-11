// A zoomed WebGL grid is a little narrower than its layout, as its cells hold whole device pixels (`terminal-sharpness.ts`).
// Plain space there already shows the terminal's background, but a row coloured to its full width would stop short, so a
// strip beside the grid carries each row's last colour on to the layout's right side. It is one pixel per row, stretched, so it
// costs next to nothing and its bands can't drift from the rows: it sits inside the terminal's screen, under its transform.
import type { IBufferCell, Terminal } from '@xterm/xterm';

interface ThemeColour {
  css: string;
}

/** The slice of xterm's (private) theme service's colours this reads; terminal-sharpness.test.ts looks for the service's name in its bundle. */
export interface ThemeColours {
  background: ThemeColour;
  foreground: ThemeColour;
  ansi: ThemeColour[];
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`;

/** The colour a row carries on past its last cell: what that cell paints behind its text. */
export function stripColour(cell: IBufferCell | undefined, colours: ThemeColours): string {
  if (cell === undefined) return colours.background.css;
  if (cell.isInverse()) {
    if (cell.isFgRGB()) return hex(cell.getFgColor());
    if (cell.isFgPalette()) return colours.ansi[cell.getFgColor()]?.css ?? colours.foreground.css;
    return colours.foreground.css;
  }
  if (cell.isBgRGB()) return hex(cell.getBgColor());
  if (cell.isBgPalette()) return colours.ansi[cell.getBgColor()]?.css ?? colours.background.css;
  return colours.background.css;
}

/** Where the strip goes, in the screen's own CSS pixels. No width: no strip. */
export interface StripBox {
  left: number;
  width: number;
  height: number;
}

export interface StripFill {
  place(box: StripBox): void;
  dispose(): void;
}

/** Keeps a strip beside `terminal`'s grid in the colours of its rows, from the rows' own redraws on. */
export function fillStrip(terminal: Terminal, screen: HTMLElement, colours: () => ThemeColours): StripFill {
  let strip: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  let shown = false;

  const paint = (start: number, end: number) => {
    if (!shown || context === null) return;
    const { active } = terminal.buffer;
    const cell = active.getNullCell();
    const theme = colours();
    for (let row = start; row <= end; row++) {
      context.fillStyle = stripColour(active.getLine(active.viewportY + row)?.getCell(terminal.cols - 1, cell), theme);
      context.fillRect(0, row, 1, 1);
    }
  };
  const rendered = terminal.onRender(({ start, end }) => paint(start, end));

  return {
    place({ left, width, height }) {
      shown = width > 0;
      if (!shown) {
        strip?.style.setProperty('display', 'none');
        return;
      }
      if (strip === undefined) {
        strip = screen.ownerDocument.createElement('canvas');
        // A layer by name, as xterm's own 2D canvases are: not the renderer's canvas.
        strip.className = 'xterm-strip-fill-layer';
        strip.width = 1;
        Object.assign(strip.style, { position: 'absolute', top: '0', pointerEvents: 'none', imageRendering: 'pixelated' });
        screen.appendChild(strip);
      }
      if (strip.height !== terminal.rows) strip.height = terminal.rows;
      context ??= strip.getContext('2d', { alpha: false });
      Object.assign(strip.style, { display: 'block', left: `${left}px`, width: `${width}px`, height: `${height}px` });
      paint(0, terminal.rows - 1);
    },
    dispose() {
      rendered.dispose();
      strip?.remove();
    },
  };
}
