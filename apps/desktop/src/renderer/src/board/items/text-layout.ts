/** The width of `text` on one line, px. */
export type MeasureLine = (text: string) => number;

export interface TextLayout {
  /** The lines as drawn, after wrapping. */
  lines: string[];
  /** The widest line, px. */
  width: number;
}

/**
 * `text` laid out in lines: broken at newlines, and, when `maxWidth` is given, wrapped at spaces to fit it (a word
 * wider than that gets its own line). With no `maxWidth` the text keeps its own lines, so its width is the widest.
 */
export function layoutText(text: string, measure: MeasureLine, maxWidth?: number): TextLayout {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (maxWidth === undefined) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && measure(next) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return { lines, width: Math.max(0, ...lines.map(measure)) };
}

export interface TextBox {
  /** px */
  padding: number;
  /** px */
  lineHeight: number;
  minWidth: number;
  /** Room after the last character, so the caret doesn't wrap the line it ends. */
  slack: number;
}

/**
 * The size a text item takes: as wide as its longest line unless `width` fixes it (then it wraps), and as tall as its
 * lines. Never under `minWidth` wide.
 */
export function textItemSize(
  text: string,
  measure: MeasureLine,
  box: TextBox,
  width?: number,
): { width: number; height: number } {
  const inner = width === undefined ? undefined : Math.max(1, width - 2 * box.padding);
  const layout = layoutText(text, measure, inner);
  return {
    width: width ?? Math.max(box.minWidth, Math.ceil(layout.width + box.slack + 2 * box.padding)),
    height: Math.ceil(layout.lines.length * box.lineHeight + 2 * box.padding),
  };
}
