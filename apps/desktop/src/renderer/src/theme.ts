/**
 * Reads a theme token (tokens.css) for code that needs its resolved value rather than var(): a canvas such as xterm's,
 * or a library option that takes a number. Read from `element` to see the theme it sits in. A token that isn't
 * defined is a bug (tokens.test.ts checks every name read here exists), so it throws rather than return nothing.
 */
export function token(name: `--${string}`, element: Element = document.documentElement): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  if (value === '') throw new Error(`theme token ${name} is not defined`);
  return value;
}

const UNITS: Record<string, number> = { '': 1, px: 1, ms: 1, s: 1000 };

/** A length token in px, or a duration token in ms (written in ms or s), as a number. */
export function tokenNumber(name: `--${string}`, element?: Element): number {
  return parseTokenNumber(name, token(name, element));
}

/** `value` of token `name` as a number: px as is, durations in ms. Throws on anything else. */
function parseTokenNumber(name: string, value: string): number {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|ms|s)?$/.exec(value);
  if (match === null) throw new Error(`theme token ${name} is ${JSON.stringify(value)}, not a length in px or a duration`);
  return Number(match[1]) * UNITS[match[2] ?? '']!;
}

/** A motion duration in ms (from `tokenNumber`) for a library animation CSS can't reach: none with reduced motion. */
export function motionDuration(duration: number, reducedMotion: boolean = matchMedia('(prefers-reduced-motion: reduce)').matches): number {
  return reducedMotion ? 0 : duration;
}
