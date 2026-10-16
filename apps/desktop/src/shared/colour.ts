// Colour maths on six-digit hex colours: WCAG 2 contrast, and the mixing and nudging that make a theme pack's tokens.

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];

const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `share` of `a` mixed into `b`, in sRGB as CSS's `color-mix(in srgb, a share, b)` does. */
export function mix(a: string, b: string, share: number): string {
  const [x, y] = [channels(a), channels(b)];
  return toHex(x.map((c, i) => c * share + y[i]! * (1 - share)));
}

/**
 * `colour`, or the least step of it towards white or black, whichever `backgrounds[0]` gives more room, that reads at
 * `ratio` on every one of `backgrounds`. Throws if even the far end doesn't, so a palette that can't be made to read
 * is caught when its tokens are made, not shipped.
 */
export function readable(colour: string, backgrounds: string[], ratio = 4.5): string {
  const reads = (c: string) => backgrounds.every((background) => contrast(c, background) >= ratio);
  if (reads(colour)) return colour;
  const towards = contrast('#ffffff', backgrounds[0]!) > contrast('#000000', backgrounds[0]!) ? '#ffffff' : '#000000';
  for (let step = 1; step <= 50; step++) {
    const nudged = mix(towards, colour, step / 50);
    if (reads(nudged)) return nudged;
  }
  throw new Error(`${colour} can't be made to read at ${ratio}:1 on ${backgrounds.join(', ')}`);
}

/** `colour` as hue (degrees), saturation and lightness (0 to 1). */
function toHsl(colour: string): [number, number, number] {
  const [r, g, b] = channels(colour).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const d = max - min;
  const saturation = lightness > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): string {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0), f(8), f(4)].map((c) => c * 255));
}

/**
 * `colour` as a fill that `ink` reads on at `ratio`: darkened (or, under a dark ink, lightened) by its lightness alone,
 * so it keeps its hue and saturation rather than greying as a mix with black would.
 */
export function fillUnder(colour: string, ink: string, ratio = 4.5): string {
  if (contrast(ink, colour) >= ratio) return colour;
  const [hue, saturation, lightness] = toHsl(colour);
  const darker = contrast(ink, '#000000') > contrast(ink, '#ffffff');
  for (let step = 1; step <= 100; step++) {
    const fill = fromHsl(hue, saturation, Math.min(1, Math.max(0, lightness + (darker ? -step : step) / 100)));
    if (contrast(ink, fill) >= ratio) return fill;
  }
  throw new Error(`no fill of ${colour} reads ${ink} at ${ratio}:1`);
}
