import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SHAPE_FILLS, STICKY_COLORS, TEXT_COLORS } from '@agent-board/daemon/protocol';
import { boardPaint } from './board-colors';
import { THEMES } from '../../shared/themes';

/*
 * Enforces docs/theme-tokens.md: tokens.css is the only place a colour, spacing, radius, font, shadow or motion value
 * is written, and every token is defined and read. Stylesheets are parsed with postcss; TypeScript with the compiler,
 * so comments and prose are never mistaken for values. Each offence is reported as file:line.
 */

const here = import.meta.dirname;
const read = (file: string) => readFileSync(join(here, file), 'utf8');

const sourceFiles = (dir = ''): string[] =>
  readdirSync(join(here, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'tokens.css' ? [path] : [];
  });

// Every CSS named colour (CSS Color 4), plus the system colours most likely to be reached for.
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
  darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
  firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
  mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
  midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple
  red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray
  slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen canvas canvastext buttonface buttontext field fieldtext highlight highlighttext linktext`.split(/\s+/),
);
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /#[0-9a-f]{3,8}\b/i;
/** A hex colour inside prose-like text: six or eight digits, or three or four with a letter, so `PR #123` isn't one. */
const HEX_IN_TEXT = /(?:^|[\s,(:])#(?:[0-9a-f]{6}|[0-9a-f]{8}|(?=[0-9a-f]{0,3}[a-f])[0-9a-f]{3,4})\b/i;
/** Paint values a colour position may hold without a token. */
const PAINT_KEYWORDS = /^(?:none|transparent|currentcolor|inherit|initial|unset)$/i;
const TOKEN_ONLY = /^var\(--[a-z0-9-]+\)$/;

/** CSS properties whose values are spacing, radius, type, shadow, filter, motion or a layer, so come from tokens. */
const TOKENISED_PROPERTY =
  /^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|(?:row-|column-)?gap|border(?:-[a-z]+)*-radius|font(?:-size|-family|-weight)?|letter-spacing|line-height|(?:box|text)-shadow|(?:backdrop-)?filter|(?:animation|transition)(?:-duration|-delay|-timing-function)?|z-index)$/;
/** The same, as keys of a style object (or of any object: a library option such as fitView's `duration`). */
const TOKENISED_KEY =
  /^(?:(?:padding|margin)(?:Top|Right|Bottom|Left|Block|Inline)?|(?:row|column)?[gG]ap|border\w*Radius|font(?:Size|Family|Weight)?|letterSpacing|lineHeight|(?:box|text)Shadow|(?:backdropF|f)ilter|(?:animation|transition)\w*|duration)$/;
/** Keys whose values are paint, in style objects and in options such as xterm's theme. */
const PAINT_KEY =
  /^(?:\w*[cC]olou?r|fill|stroke|background|foreground|cursor|cursorAccent|selection\w*|outline|border(?:Top|Right|Bottom|Left)?)$/;
/** SVG and HTML attributes that take paint. */
const PAINT_ATTRIBUTE = /^(?:fill|stroke|color|stopColor|floodColor|lightingColor)$/;
const TIMING_KEYWORD = /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])/;

/** What is left of a CSS value once its tokens are taken out, if it holds a literal; undefined if it holds none. */
export function literalIn(property: string, value: string): string | undefined {
  const rest = value.replace(/var\(--[a-z0-9-]+(?:,[^)]*)?\)/g, '').replace(/!important/, '');
  if (/cubic-bezier\(|steps\(|linear\(/.test(rest)) return rest.trim();
  if (/^(?:animation|transition)/.test(property) && TIMING_KEYWORD.test(rest)) return rest.trim();
  if (/^font(?:-family)?$/.test(property) && !/^\s*(?:inherit)?\s*$/.test(rest)) return rest.trim();
  const numbers = rest.match(/(?<![\w-])-?(?:\d*\.)?\d+[a-z%]*/gi) ?? [];
  return numbers.find((n) => !['0', '1', '-1'].includes(n));
}

/** A colour literal in a CSS value: hex, a colour function or a named colour. */
export function colourIn(value: string): string | undefined {
  const rest = value.replace(/var\(--[a-z0-9-]+\)/g, '').replace(/url\([^)]*\)|'[^']*'|"[^"]*"/g, '');
  const found = HEX.exec(rest) ?? COLOUR_FUNCTION.exec(rest);
  if (found) return found[0];
  return rest.match(/[a-z][a-z-]*/gi)?.find((word) => NAMED_COLOURS.has(word.toLowerCase()));
}

/** Offences in a stylesheet. `tokensFile` skips the literal checks (it is where literals live). */
export function cssOffences(file: string, css: string): string[] {
  const offences: string[] = [];
  postcss.parse(css, { from: file }).walkDecls((decl) => {
    if (decl.prop.startsWith('--')) {
      const colour = colourIn(decl.value);
      if (colour !== undefined) offences.push(`${file}:${decl.source?.start?.line}: ${decl.prop}: ${decl.value}`);
      return;
    }
    const literal = TOKENISED_PROPERTY.test(decl.prop) ? literalIn(decl.prop, decl.value) : undefined;
    if (literal !== undefined || colourIn(decl.value) !== undefined) {
      offences.push(`${file}:${decl.source?.start?.line}: ${decl.prop}: ${decl.value}`);
    }
  });
  return offences;
}

const isPaintValue = (value: string) => PAINT_KEYWORDS.test(value.trim()) || TOKEN_ONLY.test(value.trim());

/** Offences in a TypeScript or TSX file. */
export function scriptOffences(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const offences: string[] = [];
  const report = (node: ts.Node, what: string) =>
    offences.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
  /** The literal text of an expression, if it is one: a string, a template without substitutions, or a number. */
  const literal = (node: ts.Node | undefined): { text: string; numeric: boolean } | undefined => {
    if (node === undefined) return undefined;
    if (ts.isJsxExpression(node)) return literal(node.expression);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literal(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, numeric: false };
    if (ts.isNumericLiteral(node)) return { text: node.text, numeric: true };
    if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return { text: `-${node.operand.text}`, numeric: true };
    if (ts.isTemplateExpression(node)) return { text: node.getText(sf), numeric: false };
    return undefined;
  };
  const visit = (node: ts.Node) => {
    // Any string that holds a colour: a colour function, or a hex colour that can't be a number such as `PR #123`.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const text = ts.isJsxText(node) ? node.text : (node as ts.LiteralLikeNode).text;
      if (COLOUR_FUNCTION.test(text) || HEX_IN_TEXT.test(text)) report(node, `colour in ${JSON.stringify(text.trim())}`);
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text;
      const value = literal(node.initializer);
      if (value !== undefined && PAINT_KEY.test(key) && !value.numeric && !isPaintValue(value.text)) {
        report(node, `${key}: ${JSON.stringify(value.text)}`);
      } else if (value !== undefined && TOKENISED_KEY.test(key) && !(value.numeric && value.text === '0') && !TOKEN_ONLY.test(value.text)) {
        report(node, `${key}: ${value.numeric ? value.text : JSON.stringify(value.text)}`);
      }
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const value = literal(node.initializer);
      if (value !== undefined && PAINT_ATTRIBUTE.test(name) && !isPaintValue(value.text)) report(node, `${name}="${value.text}"`);
      // SVG presentation attributes can't take var(), so a font is set through style instead.
      if (value !== undefined && /^font(?:Family|Weight)$/.test(name)) report(node, `${name}="${value.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offences;
}

const tokens = read('tokens.css');
const defined = new Set<string>();
postcss.parse(tokens).walkDecls((decl) => {
  if (decl.prop.startsWith('--')) defined.add(decl.prop);
});
/**
 * Every token name a file reads: through var() in CSS or a string, or named in a string of its own, as token() /
 * tokenNumber() and board-colors.ts's token tables name them.
 */
const readsIn = (source: string) =>
  [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--[a-z0-9-]+)|'(--[a-z0-9-]+)'/g)].map((m) => (m[1] ?? m[2])!);
/**
 * Custom properties a rule sets for itself, to pick between tokens: per zone, PR state, tile state, leg and perch; and
 * those a library sets on its own elements, such as how much room Radix leaves a popover.
 */
const LOCAL = [
  '--radix-popover-content-available-height',
  '--pane-top',
  '--pane-height',
  '--pane-strip',
  '--zone-color',
  '--zone-fill-pct',
  '--rename-gap',
  '--sticky-color',
  '--sticky-ink',
  '--item-color',
  '--text-font-size',
  '--shape-fill',
  '--shape-stroke',
  '--connector-color',
  '--swatch',
  '--chip',
  '--chip-ink',
  '--chip-edge',
  '--tile-state',
  '--pill',
  '--pill-soft',
  '--stride',
  '--leave-ms',
  '--beak',
  // A review doc's severity group's colour, from its --severity-* token.
  '--severity',
  // The selection box's place on the board, and the zoom it keeps its lines and label against.
  '--box-x',
  '--box-y',
  '--box-width',
  '--box-height',
  '--zoom',
  // Where a context menu opens.
  '--anchor-x',
  '--anchor-y',
];

describe('theme tokens', () => {
  it('defines the core semantic tokens a dark theme must override', () => {
    for (const name of ['surface', 'raised', 'border', 'text', 'muted', 'accent', 'primary', 'on-primary', 'figure-ink', 'figure-paper', 'danger', 'warning', 'success']) {
      expect(defined, name).toContain(`--${name}`);
    }
  });

  it('is the only place a colour, spacing, radius, font, shadow or motion value is written', () => {
    const offences = sourceFiles().flatMap((file) =>
      file.endsWith('.css') ? cssOffences(file, read(file)) : scriptOffences(file, read(file)),
    );
    expect(offences).toEqual([]);
  });

  it('only uses tokens that exist', () => {
    const used = new Set([...sourceFiles(), 'tokens.css'].flatMap((file) => readsIn(read(file))));
    expect([...used].filter((name) => !defined.has(name) && !LOCAL.includes(name))).toEqual([]);
  });

  it('only defines tokens something reads', () => {
    const used = new Set([...sourceFiles(), 'tokens.css'].flatMap((file) => readsIn(read(file))));
    expect([...defined].filter((name) => !used.has(name))).toEqual([]);
  });
});

/** The sticky notes' colours by name (`--sticky-yellow`...), which every theme sets. */
const STICKY_TONES = STICKY_COLORS.map(({ name }) => name.toLowerCase());
/** A chat code block's highlighting colours, the session window's own. */
const CODE_COLOURS = ['keyword', 'string', 'number', 'comment', 'title', 'type', 'attr'].map((role) => `--window-code-${role}`);
/** The terminal's 16 ANSI colours. */
const ANSI_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((colour) => [`--ansi-${colour}`, `--ansi-bright-${colour}`]);

/**
 * Colour tokens the dark theme keeps as they are in the light one: brand marks, a colour on a saturated fill or the
 * session window's own palette, which is dark in every theme.
 */
const SAME_IN_EVERY_THEME = new Set([
  '--on-accent',
  '--on-primary',
  '--on-zone',
  '--snap-guide',
  '--harness-claude',
  '--linear-mark',
  '--switch-knob',
  '--window-ink',
  '--window-ink-soft',
  '--window-line',
  '--window-edge',
  '--window-raised',
  '--window-live',
  '--window-focus',
  '--window-selection',
  '--window-accent',
  '--window-danger',
  '--window-danger-soft',
  '--window-disabled',
  '--window-disabled-ink',
  '--window-notice',
  '--window-chat-you',
  '--window-chat-you-ink',
  '--window-added',
  '--window-chat-subagent',
  '--window-accent-hover',
  ...CODE_COLOURS,
  '--connector-line',
  '--reviewer-edge',
  '--step-done',
  '--shadow-tooltip',
  '--shadow-toast',
]);

/** Each scope's token declarations: `:root`, and each rule that re-points tokens for a part of the app. */
const scopes = new Map<string, Map<string, string>>();
postcss.parse(tokens).walkRules((rule) => {
  const decls = scopes.get(rule.selector) ?? new Map<string, string>();
  rule.walkDecls((decl) => void (decl.prop.startsWith('--') && decls.set(decl.prop, decl.value)));
  scopes.set(rule.selector, decls);
});

const WINDOW = "[data-surface='window']";
/** Each theme in the registry, with the scope its block sets tokens in: the light one is `:root` itself. */
const THEME_SCOPES = THEMES.map((theme) => ({ ...theme, scope: theme.id === 'light' ? ':root' : `:root[data-theme='${theme.id}']` }));
/** The themes that override the light one. */
const OVERRIDES = THEME_SCOPES.filter(({ id }) => id !== 'light');

/**
 * A colour token's hex value in the first of `scope` that sets it (falling back to `:root`), following var() aliases.
 * Several scopes stack, nearest first: the session window inside the dark theme is `[WINDOW, DARK]`.
 */
function hexOf(name: string, scope: string | string[] = ':root'): string {
  const stack = typeof scope === 'string' ? [scope] : scope;
  const value = [...stack, ':root'].map((at) => scopes.get(at)?.get(name)).find((found) => found !== undefined);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (alias) return hexOf(alias[1]!, stack);
  const hex = /^#[0-9a-f]{6}$/i.exec(value.trim());
  if (!hex) throw new Error(`${name} is ${value}, not a six-digit hex colour or an alias of one`);
  return hex[0];
}

/** WCAG 2 contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const c = parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/**
 * Text, and the background it is drawn on, for every pairing the components make (ui/ui.css and app.css). All are
 * small text, so each must reach WCAG AA's 4.5:1. Disabled controls are exempt, as WCAG has it.
 */
const TEXT_PAIRS: [text: string, background: string][] = [
  ['--text', '--surface'],
  ['--text', '--raised'],
  ['--text', '--hover'],
  ['--text', '--pressed'],
  ['--text', '--warning-soft'],
  ['--text', '--accent-faint'],
  ['--ask-ink', '--ask'],
  ['--text-soft', '--surface'],
  ['--text-soft', '--raised'],
  ['--text-soft', '--hover'],
  ['--text-soft', '--tag'],
  ['--muted', '--surface'],
  ['--muted', '--raised'],
  ['--muted', '--hover'],
  ['--placeholder', '--raised'],
  ['--kbd-ink', '--raised'],
  ['--on-primary', '--primary'],
  ['--on-primary', '--primary-hover'],
  ['--on-accent', '--accent'],
  ['--on-badge', '--badge'],
  ['--on-inverse', '--inverse'],
  ['--on-inverse-soft', '--inverse-raised'],
  ['--danger', '--raised'],
  ['--danger', '--danger-soft'],
  ['--danger', '--danger-edge'],
  ['--accent-ink', '--raised'],
  ['--accent-ink', '--accent-soft'],
  ['--accent-strong', '--accent-soft'],
  ['--toggle-on-ink', '--toggle-on'],
  ['--success', '--success-soft'],
  ['--neutral', '--neutral-soft'],
  ['--pr-open', '--pr-open-soft'],
  ['--pr-draft', '--pr-draft-soft'],
  ['--pr-merged', '--pr-merged-soft'],
  ['--pr-closed', '--pr-closed-soft'],
  ...['running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done', 'scheduled', 'stopped-by-restart', 'handing-off'].flatMap(
    (state): [string, string][] => [
      [`--state-${state}-ink`, `--state-${state}-soft`],
      [`--state-${state}-ink`, '--raised'],
    ],
  ),
];

/** The pairings the session window's controls make, checked again with its own tokens. */
const WINDOW_BACKGROUNDS = ['--surface', '--raised', '--hover', '--pressed', '--warning-soft', '--primary', '--danger-soft'];
const WINDOW_TEXTS = ['--text', '--text-soft', '--muted', '--placeholder', '--on-primary', '--danger'];

const WINDOW_PAIRS = TEXT_PAIRS.filter(([text, background]) => WINDOW_BACKGROUNDS.includes(background) && WINDOW_TEXTS.includes(text));

describe('themes', () => {
  /** The light theme's colour tokens written as a literal: a theme sets each, or the aliases would mix two looks. */
  const literalColours = () => [...scopes.get(':root')!].filter(([, value]) => colourIn(value) !== undefined).map(([name]) => name);

  it.each(THEME_SCOPES)('$id has its block in tokens.css, in its light or dark mode, on its desk', ({ scope, scheme, desk }) => {
    expect(scopes.has(scope)).toBe(true);
    const block = postcss.parse(tokens).nodes.find((node) => node.type === 'rule' && node.selector === scope) as postcss.Rule;
    expect(block.nodes.find((node) => node.type === 'decl' && node.prop === 'color-scheme')).toMatchObject({ value: scheme });
    expect(hexOf('--surface', scope)).toBe(desk);
  });

  it.each(OVERRIDES)('$id sets every colour the light theme writes, but the few that are the same in every theme', ({ scope }) => {
    const theme = scopes.get(scope)!;
    expect(literalColours().filter((name) => !theme.has(name) && !SAME_IN_EVERY_THEME.has(name))).toEqual([]);
    expect([...SAME_IN_EVERY_THEME].filter((name) => theme.has(name))).toEqual([]);
  });

  it.each(OVERRIDES)('$id only sets tokens the light theme defines', ({ scope }) => {
    expect([...scopes.get(scope)!.keys()].filter((name) => !scopes.get(':root')!.has(name))).toEqual([]);
  });

  it("the light theme draws each stored colour (a note's, a text item's, a shape's) as it was stored", () => {
    expect(Object.fromEntries([...boardPaint()].map(([name]) => [name, hexOf(name)]))).toEqual(Object.fromEntries(boardPaint()));
  });
});

/** Text in a filled shape on that fill, by the stored colours' names: `--shape-ink-blue` on `--shape-fill-pink`. */
const SHAPE_TEXT_PAIRS = TEXT_COLORS.flatMap(({ name: ink }) =>
  SHAPE_FILLS.map(({ name: fill }): [string, string] => [
    `--shape-ink-${ink.toLowerCase()}`,
    fill === 'White' ? '--sticky-white' : `--shape-fill-${fill.toLowerCase()}`,
  ]),
);

describe.each(THEME_SCOPES)('text contrast in the $id theme', ({ scope }) => {
  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text, scope), hexOf(background, scope))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(WINDOW_PAIRS)('in the session window, %s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text, [WINDOW, scope]), hexOf(background, [WINDOW, scope]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CODE_COLOURS.flatMap((name) => ['--window-bg', '--window-chrome'].map((background) => [name, background])))(
    'in a chat code block, %s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text, [WINDOW, scope]), hexOf(background, [WINDOW, scope]))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(STICKY_TONES)("a %s sticky note's ink meets WCAG AA on it", (tone) => {
    expect(contrast(hexOf(`--sticky-${tone}-ink`, scope), hexOf(`--sticky-${tone}`, scope))).toBeGreaterThanOrEqual(4.5);
  });

  // The light theme's are the stored colours, as picked; a theme that redraws them must not read worse.
  it.each(SHAPE_TEXT_PAIRS)('in a filled shape, %s on %s reads at least as well as in the light theme, or meets AA', (text, background) => {
    const light = contrast(hexOf(text), hexOf(background));
    expect(contrast(hexOf(text, scope), hexOf(background, scope))).toBeGreaterThanOrEqual(Math.min(light, 4.5));
  });
});

// The light theme keeps xterm's own palette; a theme that brings its own makes every colour but black, a background
// colour more than a text one, readable on its terminal's well.
describe.each(OVERRIDES)("the $id theme's terminal palette", ({ scope }) => {
  it.each(ANSI_COLOURS.filter((name) => name !== '--ansi-black'))('%s meets WCAG AA on the well', (name) => {
    expect(contrast(hexOf(name, [WINDOW, scope]), hexOf('--window-bg', [WINDOW, scope]))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('text contrast', () => {
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('the token checks', () => {
  it('catch a literal in a stylesheet', () => {
    const offences = (css: string) => cssOffences('probe.css', css);
    expect(offences('.p { padding: 6px var(--space-2) }')).toEqual(['probe.css:1: padding: 6px var(--space-2)']);
    expect(offences('.p {\n  color: var(--text);\n  padding: 5px\n}')).toEqual(['probe.css:3: padding: 5px']);
    expect(offences('.p { color: teal; }')).toHaveLength(1);
    expect(offences('.p { background: color-mix(in srgb, var(--text) 50%, navy); }')).toHaveLength(1);
    expect(offences('.p { color: oklch(70% 0.1 200); border-color: hwb(0 0% 0%); }')).toHaveLength(2);
    expect(offences('.p { filter: drop-shadow(0 2px 4px var(--text)); text-shadow: 0 1px 0 var(--text); }')).toHaveLength(2);
    expect(offences('.p { animation: pop var(--motion-pop) cubic-bezier(0, 0, 1, 1); }')).toHaveLength(1);
    expect(offences('.p { animation: walk var(--motion-step) ease-in-out infinite; }')).toHaveLength(1);
    expect(offences('.p { font-family: Menlo, monospace; font-weight: 600; }')).toHaveLength(2);
    expect(offences('.p { --x: #fff; }')).toHaveLength(1);
    expect(offences('.p { z-index: 30; }')).toEqual(['probe.css:1: z-index: 30']);
  });

  it('pass what a stylesheet may write', () => {
    const offences = (css: string) => cssOffences('probe.css', css);
    expect(offences('/* was #fff, 12px */ .p { margin: calc(-1 * var(--space-1)) 0; font: inherit; line-height: 1; }')).toEqual([]);
    expect(offences('.p { animation: walk var(--motion-step) var(--ease-in-out) infinite alternate; white-space: nowrap; }')).toEqual([]);
    expect(offences('.p { border: 1px solid color-mix(in srgb, var(--zone-color) var(--zone-edge-mix), transparent); }')).toEqual([]);
    expect(offences('.p { z-index: var(--layer-dialog); } .q { z-index: 1; }')).toEqual([]);
  });

  it('catch a literal in TypeScript', () => {
    const offences = (source: string, file = 'probe.tsx') => scriptOffences(file, source);
    expect(offences(`const a = <div style={{ color: 'red' }} />;`)).toEqual([`probe.tsx:1: color: "red"`]);
    expect(offences(`const a = <circle fill="white" stroke="crimson" />;`)).toHaveLength(2);
    expect(offences(`const s = { fontSize: 12 };\nconst a = <div style={s} />;`)).toEqual(['probe.tsx:1: fontSize: 12']);
    expect(offences(`fitView({ duration: 300 });`, 'probe.ts')).toEqual(['probe.ts:1: duration: 300']);
    expect(offences(`new Terminal({ theme: { background: 'black', foreground: 'cyan' } });`, 'probe.ts')).toHaveLength(2);
    expect(offences(`const border = '1px solid #e2ddd1';`, 'probe.ts')).toHaveLength(1);
    expect(offences(`const a = <g fontFamily="system-ui" fontWeight="700" />;`)).toHaveLength(2);
    expect(offences(`const a = <div style={{ boxShadow: '0 1px 2px rgb(0 0 0 / 10%)' }} />;`)).not.toEqual([]);
  });

  it('pass what TypeScript may write', () => {
    const offences = (source: string) => scriptOffences('probe.tsx', source);
    expect(offences(`// was #fff\nconst a = <p title="Fixes PR #123">PR #123, issue #45</p>;`)).toEqual([]);
    expect(offences(`const a = <div style={{ color: "var(--text)", padding: 0, fontSize: 'var(--font-size-md)' }} />;`)).toEqual([]);
    expect(offences(`const a = <svg fill="none" stroke="currentColor"><circle style={{ fill: color }} /></svg>;`)).toEqual([]);
    expect(offences(`const t = { fontSize: tokenNumber('--font-size-md'), background: token('--window-bg') };`)).toEqual([]);
  });
});
