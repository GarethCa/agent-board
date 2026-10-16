import { fillUnder, mix, readable } from './colour';
import { THEME_PACKS, type PackTheme } from './theme-packs';

/*
 * Makes a theme pack's tokens from its palette (theme-packs.ts): every colour the light theme writes, so no alias mixes
 * two looks, each text colour nudged until it reads at WCAG AA on what it is drawn on. tokens.test.ts writes the result
 * to the renderer's theme-packs.css and holds every pack to the same rules as the app's own dark theme.
 */

/** The app's own two themes' declarations, as tokens.css writes them: `:root` and the dark theme's block. */
export interface BaseThemes {
  light: ReadonlyMap<string, string>;
  dark: ReadonlyMap<string, string>;
}

const WHITE = '#ffffff';
const BLACK = '#000000';
const HEX = /^#[0-9a-f]{6}$/i;

/** The sticky notes' paper, by preset name, from the palette's nearest hue. */
const STICKY_HUES = ['yellow', 'orange', 'pink', 'violet', 'blue', 'green', 'grey', 'white'] as const;

/**
 * The tokens of `theme`, in tokens.css's order: each colour in `required` (the light theme's literal colours that
 * every theme sets) and the dark theme's other overrides for a dark pack. Throws on a required token it has no value
 * for, so a token added to tokens.css is never left to the light theme's look.
 */
function packTokens(theme: PackTheme, base: BaseThemes, required: readonly string[]): Map<string, string> {
  const p = theme.palette;
  const dark = theme.scheme === 'dark';
  const tokens = new Map<string, string>();
  const set = (name: string, value: string) => tokens.set(name, value);

  // A dark pack takes the dark theme's shadows, scrims and zone tints, which aren't the palette's colours, its
  // window shadow's edge drawn in the pack's border.
  if (dark) {
    for (const [name, value] of base.dark) {
      if (!HEX.test(value)) set(name, value.replace(/#[0-9a-f]{6}/gi, p.border));
    }
  }

  /** A soft fill of `colour`: a state's pill, the accent's tint. */
  const tint = (colour: string) => mix(colour, p.tile, dark ? 0.2 : 0.14);

  // Surfaces
  const hover = mix(p.text, p.tile, 0.07);
  const pressed = mix(p.text, p.tile, 0.12);
  set('--surface', p.desk);
  set('--surface-dot', mix(p.text, p.desk, dark ? 0.12 : 0.16));
  set('--raised', p.tile);
  set('--raised-edge', mix(p.text, p.tile, 0.22));
  set('--border', p.border);
  set('--control-edge', mix(p.text, p.border, dark ? 0.06 : 0.04));
  set('--separator', mix(p.border, p.tile, 0.6));
  set('--hover', hover);
  set('--panel', p.panel);
  set('--pressed', pressed);
  set('--key-hint', mix(p.muted, p.tile, 0.75));

  // Accent: a fill white reads on, and the palette's own colour as text
  const accentFill = fillUnder(p.accentFill ?? p.accent, WHITE);
  const accentSoft = tint(p.accent);
  const accentFaint = mix(p.accent, p.tile, dark ? 0.07 : 0.04);
  const accentInk = readable(p.accent, [p.tile, accentSoft]);
  set('--accent', accentFill);
  set('--accent-strong', readable(mix(p.accent, p.text, dark ? 0.7 : 0.8), [accentSoft, p.tile]));
  set('--accent-soft', accentSoft);
  set('--accent-faint', accentFaint);
  set('--accent-ink', accentInk);
  set('--toggle-on-ink', accentInk);
  set('--primary-edge', mix(accentFill, dark ? WHITE : BLACK, 0.85));
  set('--primary-hover', fillUnder(mix(accentFill, BLACK, 0.88), WHITE));
  set('--flow-edge', p.accent);

  // Feedback
  const dangerSoft = mix(p.fail, p.tile, dark ? 0.16 : 0.07);
  const dangerEdge = mix(p.fail, p.tile, dark ? 0.3 : 0.2);
  const warningSoft = mix(p.warn, p.tile, dark ? 0.14 : 0.1);
  const successSoft = p.softs?.running ?? tint(p.ok);
  const neutralSoft = mix(p.text, p.tile, 0.06);
  set('--danger', readable(p.fail, [dangerSoft, p.tile, dangerEdge]));
  set('--danger-soft', dangerSoft);
  set('--danger-edge', dangerEdge);
  set('--warning', p.warn);
  set('--warning-soft', warningSoft);
  set('--warning-edge', mix(p.warn, p.tile, 0.4));
  const success = readable(p.inks?.running ?? p.ok, [successSoft, p.tile]);
  set('--success', success);
  set('--success-soft', successSoft);
  set('--success-fill', fillUnder(success, WHITE));
  set('--neutral', readable(p.muted, [neutralSoft, p.tile]));
  set('--neutral-soft', neutralSoft);
  set('--neutral-edge', mix(p.text, p.tile, 0.2));
  const badge = fillUnder(p.warn, WHITE);
  set('--badge', badge);
  set('--rail-token-send', 'var(--badge)');
  const badgeNeutral = mix(p.text, p.tile, 0.14);
  set('--badge-neutral', badgeNeutral);

  // Text
  const idleSoft = mix(p.text, p.tile, 0.07);
  set('--text', readable(p.text, [pressed, p.desk, p.tile, hover, warningSoft, accentFaint, badgeNeutral]));
  set('--text-soft', readable(p.soft ?? mix(p.text, p.muted, 0.55), [hover, p.desk, p.tile]));
  set('--muted', readable(p.muted, [hover, p.desk, p.tile]));
  set('--placeholder', readable(mix(p.muted, p.tile, 0.9), [p.tile]));
  set('--neutral-ink', readable(p.muted, [idleSoft, p.tile]));

  // Disabled controls, checks and focus
  set('--disabled', mix(p.text, p.tile, 0.05));
  set('--disabled-edge', mix(p.text, p.tile, 0.1));
  set('--disabled-ink', mix(p.muted, p.tile, 0.55));
  set('--check-edge', mix(p.text, p.tile, 0.3));
  set('--focus-edge', mix(p.accent, p.tile, 0.55));

  // Inverse: a chip in the text's colour
  const inverseRaised = mix(p.tile, p.text, 0.14);
  set('--inverse-raised', inverseRaised);
  set('--inverse-edge', mix(p.tile, p.text, 0.26));
  set('--on-inverse-soft', readable(mix(p.text, p.tile, 0.1), [inverseRaised]));
  set('--inverse-success', readable(p.ok, [p.text], 3));
  set('--inverse-danger', readable(p.fail, [p.text], 3));

  // Agent states
  const waitingSoft = p.softs?.waiting ?? tint(p.warn);
  const rateLimitedSoft = tint(p.hues.amber);
  const failedSoft = p.softs?.failed ?? tint(p.fail);
  const scheduledSoft = tint(p.hues.cyan);
  const stoppedSoft = mix(p.text, p.tile, 0.07);
  set('--state-running', p.ok);
  set('--state-thinking-ink', accentInk);
  set('--state-waiting', p.warn);
  // Also the warning as text, on the warning's soft fill.
  set('--state-waiting-ink', readable(p.inks?.waiting ?? p.warn, [waitingSoft, p.tile, warningSoft]));
  set('--state-waiting-soft', waitingSoft);
  set('--state-idle-soft', idleSoft);
  set('--state-rate-limited', p.hues.amber);
  set('--state-rate-limited-ink', readable(p.hues.amber, [rateLimitedSoft, p.tile]));
  set('--state-rate-limited-soft', rateLimitedSoft);
  const stateFailed = readable(p.inks?.failed ?? p.fail, [failedSoft, p.tile, dangerSoft]);
  set('--state-failed', stateFailed);
  set('--state-failed-soft', failedSoft);
  set('--state-scheduled', readable(p.hues.cyan, [scheduledSoft, p.tile]));
  set('--state-scheduled-soft', scheduledSoft);
  set('--state-stopped-by-restart', mix(p.muted, p.tile, 0.8));
  set('--state-stopped-by-restart-ink', readable(p.muted, [stoppedSoft, p.tile]));
  set('--state-stopped-by-restart-soft', stoppedSoft);
  const ask = mix(p.warn, p.tile, dark ? 0.13 : 0.08);
  set('--ask', ask);
  set('--ask-edge', mix(p.warn, p.tile, dark ? 0.3 : 0.25));
  set('--ask-ink', readable(mix(p.warn, p.text, 0.3), [ask]));

  // Pull requests and reviews
  const mergedSoft = tint(p.hues.violet);
  set('--pr-merged', readable(p.hues.violet, [mergedSoft]));
  set('--pr-merged-soft', mergedSoft);
  // A review's severity groups: each head in its colour on a tile, its count on that colour. A dark pack's marks are
  // light, with the desk's colour on them, as in the dark theme; a light pack's are deep enough for white.
  const severity = (colour: string) => (dark ? readable(colour, [p.tile, p.desk]) : readable(fillUnder(colour, WHITE), [p.tile]));
  set('--severity-blocker', severity(stateFailed));
  set('--severity-major', severity(p.warn));
  set('--severity-minor', severity(p.muted));
  if (dark) set('--on-severity', p.desk);

  // Sticky notes: paper in every theme, from the palette's hues, each with a dark ink that reads on it
  const paperHue = { yellow: p.hues.amber, orange: p.warn, pink: p.hues.pink, violet: p.hues.violet, blue: p.hues.blue, green: p.ok, grey: p.muted };
  const ink = dark ? p.desk : p.text;
  const papers = STICKY_HUES.map((name) => {
    const paper = name === 'white' ? (dark ? mix(p.text, p.tile, 0.82) : WHITE) : dark ? mix(paperHue[name], p.text, 0.62) : mix(paperHue[name], WHITE, 0.34);
    set(`--sticky-${name}`, paper);
    set(`--sticky-${name}-ink`, readable(ink, [paper]));
    return paper;
  });
  if (dark) set('--sticky-other-ink', readable(ink, papers));
  set('--sticky-link', readable(accentFill, papers, 3));

  // Text, connectors and outlines on the desk, and shapes' paper fills with text that reads on each
  set('--paint-ink', p.text);
  set('--paint-grey', p.muted);
  const paints = { red: p.hues.red, orange: p.warn, green: p.ok, blue: p.hues.blue, violet: p.hues.violet };
  for (const [name, colour] of Object.entries(paints)) set(`--paint-${name}`, readable(colour, [p.desk], 3));
  const fills = Object.entries({ yellow: p.hues.amber, green: p.ok, blue: p.hues.blue, pink: p.hues.pink }).map(([name, hue]) => {
    const fill = dark ? mix(hue, p.text, 0.45) : mix(hue, WHITE, 0.22);
    set(`--shape-fill-${name}`, fill);
    return fill;
  });
  const shapePapers = [...fills, tokens.get('--sticky-white')!];
  for (const [name, colour] of Object.entries({ ink, grey: p.muted, ...paints })) set(`--shape-ink-${name}`, readable(colour, shapePapers));

  // The session window: the terminal's well, its chrome a step off it, its text and syntax colours reading on both
  const { well, ansi } = p.term;
  const chrome = mix(p.term.ink, well, 0.05);
  const line = mix(p.term.ink, well, 0.1);
  const edge = mix(p.term.ink, well, 0.2);
  set('--window-bg', well);
  set('--window-chrome', chrome);
  set('--window-composer', mix(p.term.ink, well, 0.025));
  set('--window-field', mix(p.term.ink, well, 0.08));
  set('--window-ink', readable(p.term.ink, [edge, well, chrome, line, base.light.get('--window-notice')!]));
  const raisedInWindow = mix(p.term.ink, well, 0.15);
  // The window's own fills, the same in every theme: a diff's added, hunk and deleted rows, a notice.
  const fixed = ['--window-diff-added', '--window-diff-hunk', '--window-danger-soft', '--window-notice'].map((name) => base.light.get(name)!);
  set('--window-ink-soft', readable(mix(p.term.ink, well, 0.65), [raisedInWindow, line, well, chrome, ...fixed]));
  set('--window-line', line);
  set('--window-edge', edge);
  set('--window-raised', raisedInWindow);
  set('--window-warning', readable(mix(ansi[1]!, ansi[3]!, 0.5), [base.light.get('--window-notice')!, well, chrome]));
  const code = (colour: string) => readable(colour, [chrome, well]);
  set('--window-added', readable(ansi[10]!, [chrome, well, base.light.get('--window-diff-added')!]));
  set('--window-code-keyword', code(ansi[5]!));
  set('--window-code-string', code(ansi[2]!));
  set('--window-code-number', code(mix(ansi[1]!, ansi[3]!, 0.5)));
  set('--window-code-comment', code(ansi[8]!));
  set('--window-code-title', code(ansi[4]!));
  set('--window-code-type', code(ansi[3]!));
  set('--window-code-attr', code(ansi[6]!));
  const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  ansi.forEach((colour, slot) => {
    const name = `--ansi-${slot >= 8 ? 'bright-' : ''}${ANSI_NAMES[slot % 8]}`;
    set(name, slot === 0 ? colour : readable(colour, [well]));
  });

  // A light pack keeps the light theme's shadows, scrims and tints, which aren't the palette's colours.
  for (const name of required) {
    if (tokens.has(name)) continue;
    const value = dark ? undefined : base.light.get(name);
    if (value === undefined || HEX.test(value)) throw new Error(`${theme.id}: no value for ${name}`);
    set(name, value);
  }

  const order = [...base.light.keys()];
  return new Map([...tokens].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
}

/** theme-packs.css: one `:root[data-theme]` block per pack theme, headed by its credit. */
export function themePacksCss(base: BaseThemes, required: readonly string[]): string {
  const blocks = THEME_PACKS.flatMap(({ credit, themes }) =>
    themes.map((theme) => {
      const declarations = [...packTokens(theme, base, required)].map(([name, value]) => `  ${name}: ${value};`);
      return [`/* ${theme.name}: ${credit} */`, `:root[data-theme='${theme.id}'] {`, `  color-scheme: ${theme.scheme};`, ...declarations, '}'].join('\n');
    }),
  );
  return [
    '/*',
    ' * The theme packs, made from their palettes (shared/theme-packs.ts) by shared/theme-pack-tokens.ts. Generated: edit',
    ' * the palette, then run `pnpm vitest run apps/desktop/src/renderer/src/tokens.test.ts -u` to write this file again.',
    ' */',
    ...blocks,
    '',
  ].join('\n');
}
