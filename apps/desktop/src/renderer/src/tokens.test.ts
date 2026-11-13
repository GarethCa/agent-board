import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RAIL_TOKEN_ROOM } from '@agent-board/daemon/board-layout';
import { COLOR_SLOTS, FILL_SLOTS, STICKY_COLORS, ZONE_COLORS } from '@agent-board/daemon/protocol';
import { boardPaint } from './board-colors';
import { contrast, mix } from '../../shared/colour';
import { NOTE_TAB_ROOM, NOTE_TILE_RATIO, themePacksCss } from '../../shared/theme-pack-tokens';
import { THEMES } from '../../shared/themes';

/*
 * Enforces docs/theme-tokens.md: tokens.css (and theme-packs.css, made from the packs' palettes) is the only place a colour, spacing, radius, font, shadow or motion value
 * is written, and every token is defined and read. Stylesheets are parsed with postcss; TypeScript with the compiler,
 * so comments and prose are never mistaken for values. Each offence is reported as file:line.
 */

const here = import.meta.dirname;
const read = (file: string) => readFileSync(join(here, file), 'utf8');

/** Where tokens are written: the app's own themes, and the theme packs' (generated). */
const TOKEN_FILES = ['tokens.css', 'theme-packs.css'];

const sourceFiles = (dir = ''): string[] =>
  readdirSync(join(here, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !TOKEN_FILES.includes(entry.name) ? [path] : [];
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

const tokens = TOKEN_FILES.map(read).join('\n');
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
  // A board background's pattern: the board sets where it is and how big on a moving one, and the rules derive the rest.
  '--backdrop-x',
  '--backdrop-y',
  '--backdrop-zoom',
  '--backdrop-gap',
  '--backdrop-dot',
  '--backdrop-dot-zoom',
  '--backdrop-ink',
  '--backdrop-radius',
  '--backdrop-cell',
  '--backdrop-row',
  // The dock sets how much room it leaves each side from script (`useDockScroll`).
  '--dock-left',
  '--dock-right',
  '--dock-lift',
  // The docked pane's bottom, set inline from script (`usePanelRoom` measures the zoom bar's and the minimap's top).
  '--controls-lift',
  '--edge-room',
  // The Captain's pane sets on the board how far it pushes the board's edge in, and its width (`MasterPanel`).
  '--captain-room',
  '--captain-edge',
  '--captain-push',
  '--captain-beside',
  // How far the creation toolbar moves off the board's middle to clear the islands (`useChromeFolds`).
  '--toolbar-shift',
  '--for-you-height',
  '--dock-room',
  '--radix-popover-content-available-width',
  '--radix-popover-content-available-height',
  '--radix-dropdown-menu-content-available-height',
  '--pane-top',
  '--pane-height',
  '--pane-strip',
  '--zone-color',
  '--zone-fill-pct',
  // A work category's colours in the Overview, set on a card or group by its category.
  '--overview-cat',
  '--overview-cat-ink',
  '--overview-cat-soft',
  // The colour of the zone a note sits in, set on the note, and the edge colour derived from it.
  '--agent-note-zone',
  '--agent-note-edge',
  '--rename-gap',
  // An agent tile's own fill, set by the state rules that change it, under its head's hover buttons.
  '--tile-fill',
  // How far through an agent says it is, set inline on its tile's progress hairline.
  '--progress',
  '--sticky-color',
  '--sticky-ink',
  '--item-color',
  '--text-font-size',
  '--shape-fill',
  '--shape-stroke',
  '--shape-stroke-width',
  '--shape-stroke-style',
  '--connector-color',
  '--swatch',
  '--swatch-edge',
  '--chip',
  '--sender',
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
  // Where an agent's shelf peek opens, beside the rail icon clicked.
  '--peek-top',
  // Where a context menu opens, or Ask Claude's popover points.
  '--anchor-x',
  '--anchor-y',
  // Where a suggested edit's ghost shape and its chip sit on the board.
  '--ghost-x',
  '--ghost-y',
  '--chip-x',
  '--chip-y',
  // A theme's colours in its swatch in Settings, from the registry, as its tokens aren't the page's until it shows.
  '--preview-desk',
  '--preview-edge',
  '--preview-accent',
  '--preview-running',
  '--preview-waiting',
  '--preview-failed',
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
    const used = new Set([...sourceFiles(), ...TOKEN_FILES].flatMap((file) => readsIn(read(file))));
    expect([...used].filter((name) => !defined.has(name) && !LOCAL.includes(name))).toEqual([]);
  });

  it("gives a rail's token the room the daemon's arrange leaves between linked tiles", () => {
    let room: string | undefined;
    postcss.parse(tokens).walkDecls('--rail-token-room', (decl) => void (room = decl.value));
    expect(room).toBe(`${RAIL_TOKEN_ROOM}px`);
  });

  it('only defines tokens something reads', () => {
    const used = new Set([...sourceFiles(), ...TOKEN_FILES].flatMap((file) => readsIn(read(file))));
    expect([...defined].filter((name) => !used.has(name))).toEqual([]);
  });

  // A status's fill (`--state-waiting`) is tuned to be a dot or an outline; its ink (`--state-waiting-ink`) is the one
  // held to AA as text. Glyphs that are only a status's dot may keep the fill.
  it("draws a status's colour as text in its ink, not its fill", () => {
    const GLYPHS_ONLY = new Set(['.web-server::before', ".shelf-member[data-status='needs-you'] .shelf-member-glyph", ".shelf-member[data-status='problem'] .shelf-member-glyph"]);
    const fillWithInk = (name: string) => name.startsWith('--state-') && defined.has(`${name}-ink`);
    const offences = sourceFiles()
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => {
        const found: string[] = [];
        postcss.parse(read(file)).walkDecls('color', (decl) => {
          const token = /^var\((--[a-z0-9-]+)\)$/.exec(decl.value)?.[1];
          const selector = decl.parent?.type === 'rule' ? (decl.parent as postcss.Rule).selector : '';
          if (token !== undefined && fillWithInk(token) && !GLYPHS_ONLY.has(selector)) found.push(`${file}:${decl.source?.start?.line} ${selector} reads ${token}`);
        });
        return found;
      });
    expect(offences).toEqual([]);
  });
});

/** The sticky notes' colours by name (`--sticky-yellow`...), which every theme sets. */
const STICKY_TONES = STICKY_COLORS.map(({ name }) => name.toLowerCase());
/** A chat code block's highlighting colours, the session window's own. */
const CODE_COLOURS = ['keyword', 'string', 'number', 'comment', 'title', 'type', 'attr'].map((role) => `--window-code-${role}`);
/** The terminal's 16 ANSI colours. */
const ANSI_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((colour) => [`--ansi-${colour}`, `--ansi-bright-${colour}`]);

/**
 * The session window's own palette that a theme may bring with its terminal, or keep as the light theme has it: its
 * text and lines over the well, and a chat code block's and a diff's highlighting. The dark theme keeps them; a theme
 * pack brings its own.
 */
const WINDOW_PALETTE = new Set([
  '--window-ink',
  '--window-ink-soft',
  '--window-line',
  '--window-edge',
  '--window-raised',
  '--window-added',
  '--window-warning',
  ...CODE_COLOURS,
]);

/**
 * Colour tokens every theme keeps as they are in the light one: brand marks, a colour on a saturated fill, the
 * Captain's hat and its emblem or the rest of the session window's own palette, which is dark in every theme.
 */
const SAME_IN_EVERY_THEME = new Set([
  '--desk-vignette',
  '--on-accent',
  '--on-primary',
  '--on-zone',
  '--snap-guide',
  '--harness-claude',
  '--figure-eye',
  '--figure-hat',
  '--figure-hat-emblem',
  '--linear-mark',
  '--switch-knob',
  '--demo-cursor-fill',
  '--demo-cursor-edge',
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
  '--agent-note-term-strong',
  '--agent-note-term-edited',
  '--agent-note-term-link',
  '--window-diff-added',
  '--window-diff-hunk',
  '--window-chat-subagent',
  '--window-limit-soft',
  '--window-accent-hover',
  '--connector-line',
  '--reviewer-edge',
  '--step-done',
  '--shadow-tooltip',
  '--shadow-toast',
  '--shadow-chat-pop',
]);

/** Each scope's token declarations: `:root`, and each rule that re-points tokens for a part of the app. */
const scopes = new Map<string, Map<string, string>>();
postcss.parse(tokens).walkRules((rule) => {
  for (const selector of rule.selectors) {
    const decls = scopes.get(selector) ?? new Map<string, string>();
    rule.walkDecls((decl) => void (decl.prop.startsWith('--') && decls.set(decl.prop, decl.value)));
    scopes.set(selector, decls);
  }
});

const WINDOW = "[data-surface='window']";
/** Each theme in the registry, with the scope its block sets tokens in: the light one is `:root` itself. */
const THEME_SCOPES = THEMES.map((theme) => {
  const scope = theme.id === 'light' ? ':root' : `:root[data-theme='${theme.id}']`;
  return { ...theme, scope, stack: [scope] };
});
/** The themes that override the light one. */
const OVERRIDES = THEME_SCOPES.filter(({ id }) => id !== 'light');

const DARK = ":root[data-theme='dark']";
const SIMPLIFIED = ":root[data-design='simplified']";
const SIMPLIFIED_DARK = ":root[data-design='simplified'][data-theme='dark']";
/**
 * The Simplified design in each mode, as the scopes it reads, nearest first. Its dark block outranks the rest; its light
 * block comes after the dark theme in tokens.css, so its aliases and the values the dark block leaves alone win there.
 */
const SIMPLIFIED_SCOPES = [
  { id: 'simplified', scheme: 'light' as const, stack: [SIMPLIFIED] },
  { id: 'simplified-dark', scheme: 'dark' as const, stack: [SIMPLIFIED_DARK, SIMPLIFIED, DARK] },
];
/**
 * The Simplified design over each theme pack: its own block for the pack outranks the rest, then the pack's, which comes
 * after tokens.css and so wins over the Simplified light block where both set a token. The app's own dark blocks never
 * match a pack.
 */
const SIMPLIFIED_PACK_SCOPES = THEME_SCOPES.filter(({ family }) => family !== undefined).map((theme) => {
  const scope = `:root[data-design='simplified'][data-theme='${theme.id}']`;
  return { ...theme, id: `simplified-${theme.id}`, theme, scope, stack: [scope, theme.scope, SIMPLIFIED] };
});
/** Every look the app can show: each theme, and the Simplified design in each mode and over each theme pack. */
const LOOKS = [...THEME_SCOPES, ...SIMPLIFIED_SCOPES, ...SIMPLIFIED_PACK_SCOPES];

/**
 * A colour token's hex value in the first of `scope` that sets it (falling back to `:root`), following var() aliases.
 * Several scopes stack, nearest first: the session window inside the dark theme is `[WINDOW, DARK]`.
 */
function hexOf(name: string, scope: string | string[] = ':root'): string {
  const stack = typeof scope === 'string' ? [scope] : scope;
  const value = resolve(name, [...stack, ':root'], 0);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is ${value}, not a six-digit hex colour or an alias of one`);
  return value;
}

/** Scopes on the root element are one element: a var() there resolves against all of them together. */
const onRoot = (selector: string) => selector.startsWith(':root');

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

/**
 * `name` as the first scope from `from` outwards sets it, worked out where it can be: each var() in it, then a
 * `color-mix(in srgb, #a n%, #b)` to its hex, or one with `transparent` to `#rrggbbaa`. Anything else (a shadow, a
 * var() with a fallback) comes back as written with its var()s worked out. A var() resolves where it is declared, as
 * CSS has it: its target is looked up again from that element's own scopes, not from the nearest scope of the stack,
 * so a scope on a child element doesn't re-point an alias declared above it.
 */
function resolve(name: string, stack: string[], from: number): string {
  const at = stack.findIndex((each, index) => index >= from && scopes.get(each)?.get(name) !== undefined);
  if (at < 0) throw new Error(`${name} is not defined`);
  let start = at;
  while (start > from && onRoot(stack[start - 1]!) && onRoot(stack[at]!)) start--;
  const value = scopes.get(stack[at]!)!.get(name)!.trim().replace(/var\((--[a-z0-9-]+)\)/g, (_, ref: string) => resolve(ref, stack, start));
  const blend = /^color-mix\(in srgb, (#[0-9a-f]{6}) ([\d.]+)%, (#[0-9a-f]{6}|transparent)\)$/i.exec(value);
  if (!blend) return value;
  const [a, b, share] = [blend[1]!, blend[3]!, Number(blend[2]) / 100];
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  if (b === 'transparent') return `${a}${hex(share * 255)}`;
  return `#${[0, 1, 2].map((i) => hex(channel(a, i) * share + channel(b, i) * (1 - share))).join('')}`;
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
  // A review doc's severity groups: each head in its colour, and its count on it (ReviewViewer, outside the window).
  ...['blocker', 'major', 'minor'].flatMap((severity): [string, string][] => [
    [`--severity-${severity}`, '--raised'],
    ['--on-severity', `--severity-${severity}`],
  ]),
  ['--success', '--success-soft'],
  ['--neutral', '--neutral-soft'],
  ['--pr-open', '--pr-open-soft'],
  ['--pr-draft', '--pr-draft-soft'],
  ['--pr-merged', '--pr-merged-soft'],
  ['--pr-closed', '--pr-closed-soft'],
  ...['running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done', 'scheduled', 'stopped-by-restart', 'handing-off', 'on-command', 'hibernated'].flatMap(
    (state): [string, string][] => [
      [`--state-${state}-ink`, `--state-${state}-soft`],
      [`--state-${state}-ink`, '--raised'],
    ],
  ),
];

/** The pairings the session window's controls make, checked again with its own tokens. */
const WINDOW_BACKGROUNDS = ['--surface', '--raised', '--hover', '--pressed', '--warning-soft', '--primary', '--danger-soft'];
const WINDOW_TEXTS = ['--text', '--text-soft', '--muted', '--placeholder', '--on-primary', '--danger'];

const WINDOW_PAIRS = [
  ...TEXT_PAIRS.filter(([text, background]) => WINDOW_BACKGROUNDS.includes(background) && WINDOW_TEXTS.includes(text)),
  // A banner over a terminal: an agent that exited, a pane that ended.
  ['--window-ink-soft', '--window-raised'],
  // A PR tab's diff: the Open chip, and the line numbers on an added, deleted or hunk row.
  ['--window-added', '--window-diff-added'],
  ['--muted', '--window-diff-added'],
  ['--muted', '--window-diff-hunk'],
  ['--muted', '--danger-soft'],
  // A shell astray in another agent's worktree: its warning tag.
  ['--warning-ink', '--warning-soft'],
];

/** A rule's text colour and its own background, each a token, as a stylesheet draws them together. */
function drawnPairs(): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  for (const file of sourceFiles().filter((name) => name.endsWith('.css'))) {
    postcss.parse(read(file)).walkRules((rule) => {
      let text: string | undefined;
      let background: string | undefined;
      rule.each((node) => {
        const token = node.type === 'decl' ? /^var\((--[a-z0-9-]+)\)$/.exec(node.value.trim())?.[1] : undefined;
        if (node.type !== 'decl' || token === undefined) return;
        if (node.prop === 'color') text = token;
        if (node.prop === 'background' || node.prop === 'background-color') background = token;
      });
      if (text === undefined || background === undefined) return;
      const key = `${text} on ${background}`;
      pairs.set(key, [...(pairs.get(key) ?? []), `${file}:${rule.source?.start?.line}`]);
    });
  }
  return pairs;
}

/** Pairs a rule draws that aren't text WCAG holds to 4.5:1, and why. */
const NOT_TEXT = new Map([
  ['--disabled-ink on --disabled', 'a disabled control: WCAG exempts its text'],
  ['--on-accent on --state-running', "onboarding's ready badge: a tick icon, not text"],
]);

describe('themes', () => {
  /** The light theme's colour tokens written as a literal: a theme sets each, or the aliases would mix two looks. */
  const literalColours = () => [...scopes.get(':root')!].filter(([, value]) => colourIn(value) !== undefined).map(([name]) => name);

  it.each(THEME_SCOPES)('$id has its block in tokens.css, in its light or dark mode, on its desk', ({ scope, scheme, desk }) => {
    expect(scopes.has(scope)).toBe(true);
    const block = postcss.parse(tokens).nodes.find((node) => node.type === 'rule' && node.selector === scope) as postcss.Rule;
    expect(block.nodes.find((node) => node.type === 'decl' && node.prop === 'color-scheme')).toMatchObject({ value: scheme });
    expect(hexOf('--surface', scope)).toBe(desk);
  });

  it.each(THEME_SCOPES.filter(({ family }) => family === undefined))("$id's preview in the Theme popover is its tokens", ({ scope, preview }) => {
    const token = { desk: '--surface', edge: '--border', accent: '--accent', running: '--state-running', waiting: '--state-waiting', failed: '--state-failed' };
    for (const [role, name] of Object.entries(token)) expect(preview[role as keyof typeof preview], role).toBe(hexOf(name, scope));
  });

  it.each(OVERRIDES)('$id sets every colour the light theme writes, but the few that are the same in every theme', ({ scope }) => {
    const theme = scopes.get(scope)!;
    const optional = (name: string) => SAME_IN_EVERY_THEME.has(name) || WINDOW_PALETTE.has(name);
    expect(literalColours().filter((name) => !theme.has(name) && !optional(name))).toEqual([]);
    expect([...SAME_IN_EVERY_THEME].filter((name) => theme.has(name))).toEqual([]);
  });

  it.each(OVERRIDES)('$id only sets tokens the light theme defines', ({ scope }) => {
    expect([...scopes.get(scope)!.keys()].filter((name) => !scopes.get(':root')!.has(name))).toEqual([]);
  });

  it("makes theme-packs.css from the packs' palettes, each setting every colour but those the same in every theme", async () => {
    const declarations = (scope: string) => new Map([...scopes.get(scope)!]);
    const required = literalColours().filter((name) => !SAME_IN_EVERY_THEME.has(name));
    const simplified = { light: declarations(SIMPLIFIED), dark: declarations(SIMPLIFIED_DARK) };
    const css = themePacksCss({ light: declarations(':root'), dark: declarations(DARK), simplified }, required);
    await expect(css).toMatchFileSnapshot('./theme-packs.css');
  });

  /*
   * The palette each theme draws, on the board and on each surface that re-points its tokens: every colour
   * token worked out as far as `resolve` can (aliases, opaque and `transparent` mixes). The visual baselines can't hold
   * it: Playwright's per-pixel threshold passes a colour a few levels off (the grey note paper made beige by mistake is a
   * YIQ difference of 4.4 where its default allows 1,408), and a threshold tight enough to catch that would fail on
   * anti-aliasing (docs/theme-tokens.md, "Visual regression"). So a colour that moves fails here: the file names the
   * theme and each key its surface and token. A change meant to move one updates the files with `vitest run -u`.
   * A pack's entries repeat much of theme-packs.css's snapshot above; keep them, as a token a pack leaves unset falls
   * through to the light theme's and only these files show it. The Simplified looks draw Classic's palette (above).
   */
  const SURFACES = [
    ['window', [WINDOW]],
    ['chat-light', ["[data-chat-theme='light']", WINDOW]],
    ['chat-match', ["[data-chat-theme='match']", WINDOW]],
    ['master-panel', ['.master-panel-chat']],
    ['settings', ['.settings-window']],
  ] as const;

  it.each(THEME_SCOPES)("draws the $id palette as its snapshot holds it", async ({ id, stack }) => {
    const entries = (surface: string, names: Iterable<string>, at: string[]) =>
      [...names].map((name) => [`${surface} ${name}`, resolve(name, [...at, ...stack, ':root'], 0)] as const).filter(([, value]) => colourIn(value) !== undefined);
    // A surface's own scopes are on a child element: only the tokens they set differ from the board's.
    const palette = Object.fromEntries([
      ...entries('board', scopes.get(':root')!.keys(), []),
      ...SURFACES.flatMap(([surface, at]) => entries(surface, new Set(at.flatMap((scope) => [...scopes.get(scope)!.keys()])), [...at])),
    ]);
    await expect(`${JSON.stringify(palette, null, 2)}\n`).toMatchFileSnapshot(`./__snapshots__/palette/${id}.json`);
  });

  it("the light theme draws each stored colour (a note's, a text item's, a shape's) as it was stored", () => {
    expect(Object.fromEntries([...boardPaint()].map(([name]) => [name, hexOf(name)]))).toEqual(Object.fromEntries(boardPaint()));
  });
});

describe('the Simplified design', () => {
  const simplified = scopes.get(SIMPLIFIED)!;
  const simplifiedDark = scopes.get(SIMPLIFIED_DARK)!;

  it('only sets tokens the light theme defines, and none of those that are the same in every theme', () => {
    for (const block of [simplified, simplifiedDark]) {
      expect([...block.keys()].filter((name) => !scopes.get(':root')!.has(name))).toEqual([]);
      expect([...SAME_IN_EVERY_THEME].filter((name) => block.has(name))).toEqual([]);
    }
  });

  it('has a dark value for every colour its light block writes', () => {
    const written = [...simplified].filter(([, value]) => colourIn(value) !== undefined).map(([name]) => name);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => !simplifiedDark.has(name))).toEqual([]);
  });

  it.each(SIMPLIFIED_SCOPES)("opens a window in $id on the theme's own desk", ({ scheme, stack }) => {
    const theme = THEMES.find((each) => each.id === scheme)!;
    expect(hexOf('--surface', stack)).toBe(theme.desk);
  });

  /**
   * Classic's palette, as each Simplified look draws it: every token Classic writes a colour in, but the elevation the
   * design draws its own way (its hairline, soft shadow and lighter dim) and the dots it leaves off the desk.
   */
  const palette = () =>
    [...scopes.get(':root')!]
      .filter(([name, value]) => colourIn(value) !== undefined && !/^--(shadow-|sticky-shadow$|scrim$|surface-dot$)/.test(name))
      .map(([name]) => name);
  /** A token as a look draws it, worked out as far as `resolve` can. */
  const drawnIn = (name: string, stack: string[]): string => resolve(name, [...stack, ':root'], 0);
  const CLASSIC_OF = [
    ...SIMPLIFIED_SCOPES.map(({ id, scheme, stack }) => ({ id, stack, classic: scheme === 'dark' ? [DARK] : [] })),
    ...SIMPLIFIED_PACK_SCOPES.map(({ id, stack, theme }) => ({ id, stack, classic: [theme.scope] })),
  ];

  it.each(CLASSIC_OF)("draws every colour of Classic's palette as Classic does, in $id", ({ stack, classic }) => {
    const differ = palette().filter((name) => drawnIn(name, stack) !== drawnIn(name, classic));
    expect(differ.map((name) => `${name}: ${drawnIn(name, stack)} (Classic ${drawnIn(name, classic)})`)).toEqual([]);
  });

  /**
   * All the design may set, in any look: its shapes, type, rail width and token face, shadows, the dim behind a sheet and
   * the desk's dots and its zones' fainter tint. A colour, an alias of one, a mix or a zone's tint would fork Classic's palette, so none is here.
   */
  const MAY_SET = new Set([
    '--surface-dot',
    '--zone-fill-mix',
    '--rail-width',
    '--rail-token-font',
    '--shadow-tile',
    '--sticky-shadow',
    '--shadow-expanded',
    '--shadow-control',
    '--shadow-primary',
    '--shadow-input',
    '--shadow-overlay',
    '--shadow-island',
    '--scrim',
    '--radius-lg',
    '--radius-item',
    '--radius-window',
    '--radius-2xl',
    '--font-sans',
    '--font-mono',
    '--font-wordmark',
    '--font-size-xs',
    '--font-size-2xl',
  ]);
  const OWN_SCOPES = new Set([SIMPLIFIED, SIMPLIFIED_DARK, ...SIMPLIFIED_PACK_SCOPES.map(({ scope }) => scope)]);

  it('sets tokens in its own blocks only, and in them only its shapes, type and shadows', () => {
    const flagged = [...scopes.keys()].filter((selector) => selector.includes("[data-design='simplified']"));
    expect(flagged.filter((selector) => !OWN_SCOPES.has(selector))).toEqual([]);
    for (const selector of flagged) expect([...scopes.get(selector)!.keys()].filter((name) => !MAY_SET.has(name)), selector).toEqual([]);
  });

  it("sets no token in a component's rules", () => {
    const set = sourceFiles()
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => {
        const found: string[] = [];
        postcss.parse(read(file)).walkRules((rule) => {
          if (!rule.selector.includes("data-design='simplified'")) return;
          rule.walkDecls((decl) => void (decl.prop.startsWith('--') && found.push(`${file}: ${rule.selector} ${decl.prop}`)));
        });
        return found;
      });
    expect(set).toEqual([]);
  });

  it("draws every character's body in Classic's terracotta, with no colour of its own", () => {
    expect(scopes.get(':root')!.get('--figure-body')).toBe('var(--harness-claude)');
    const painted: string[] = [];
    postcss.parse(read('app.css')).walkRules((rule) => {
      if (rule.selector.includes('character-body')) rule.walkDecls((decl) => void painted.push(`${rule.selector} ${decl.prop}: ${decl.value}`));
    });
    expect(painted).toEqual(['.character-body fill: var(--figure-body)']);
  });

  it('draws the desk plain, with no dots', () => {
    for (const { stack } of [...SIMPLIFIED_SCOPES, ...SIMPLIFIED_PACK_SCOPES]) expect(hexOf('--surface-dot', stack)).toBe(hexOf('--surface', stack));
  });

  it("tints a zone fainter than Classic does, and leaves Classic's tint as it was", () => {
    const fill = (stack: string[]) => Number.parseFloat(drawnIn('--zone-fill-mix', stack));
    expect(fill([])).toBe(8);
    expect(fill([DARK])).toBe(6);
    for (const { stack, scheme } of SIMPLIFIED_SCOPES) expect(fill(stack)).toBeLessThan(fill(scheme === 'dark' ? [DARK] : []));
    for (const { stack, theme } of SIMPLIFIED_PACK_SCOPES) expect(fill(stack)).toBeLessThan(fill([theme.scope]));
  });

  it("keeps a zone's edge as Classic draws it", () => {
    for (const { stack, classic } of CLASSIC_OF) expect(drawnIn('--zone-edge-mix', stack)).toBe(drawnIn('--zone-edge-mix', classic));
  });

  describe.each(SIMPLIFIED_PACK_SCOPES)('over $name', ({ scope, scheme, theme, stack }) => {
    const block = () => scopes.get(scope)!;
    /** What the Simplified design's own blocks set in the pack's mode: its light block, and its dark one over it. */
    const own = () => new Map([...simplified, ...(scheme === 'dark' ? simplifiedDark : [])]);

    it('sets every token the Simplified design sets in its mode, and no other', () => {
      expect(scopes.has(scope)).toBe(true);
      expect([...block().keys()].sort()).toEqual([...own().keys()].sort());
    });

    it("keeps the Simplified design's shapes, type, shadows and aliases as they are in its mode", () => {
      const kept = [...own()].filter(([, value]) => !/^#[0-9a-f]{6}$/i.test(value));
      expect(kept.length).toBeGreaterThan(0);
      for (const [name, value] of kept) expect(block().get(name), name).toBe(value);
    });

    it("opens a window on the pack's desk", () => {
      expect(hexOf('--surface', stack)).toBe(theme.desk);
    });
  });
});

/** A shape's fills in its slots, the tile's own aside: `--shape-fill-blue`. */
const SHAPE_FILL_TOKENS = FILL_SLOTS.filter((slot) => slot !== 'tile').map((slot) => `--shape-fill-${slot}`);

describe.each(LOOKS)('text contrast in the $id look', ({ id, stack }) => {
  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text, stack), hexOf(background, stack))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...drawnPairs()].filter(([pair]) => !NOT_TEXT.has(pair)))('%s, as a rule draws it (%j), meets WCAG AA', (pair) => {
    const [text, background] = pair.split(' on ') as [string, string];
    // A pair drawn only in the session window is read there, with its tokens.
    const inWindow = WINDOW_PAIRS.some(([t, b]) => t === text && b === background);
    const resolve = (name: string) => {
      try {
        return hexOf(name, inWindow ? [WINDOW, ...stack] : stack);
      } catch {
        return undefined; // a mix or a keyword, not a flat colour
      }
    };
    const [fg, bg] = [resolve(text), resolve(background)];
    if (fg !== undefined && bg !== undefined) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...WINDOW_PAIRS, ...CARD_PAIRS])('in the session window, %s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text, [WINDOW, ...stack]), hexOf(background, [WINDOW, ...stack]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CODE_COLOURS.flatMap((name) => ['--window-bg', '--window-chrome'].map((background) => [name, background])))(
    'in a chat code block, %s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text, [WINDOW, ...stack]), hexOf(background, [WINDOW, ...stack]))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(STICKY_TONES)("a %s sticky note's ink meets WCAG AA on it", (tone) => {
    expect(contrast(hexOf(`--sticky-${tone}-ink`, stack), hexOf(`--sticky-${tone}`, stack))).toBeGreaterThanOrEqual(4.5);
  });

  // Text in any slot may sit on any fill, the tile's too: each pair meets AA.
  it.each(COLOR_SLOTS.flatMap((slot) => ['--raised', ...SHAPE_FILL_TOKENS].map((fill) => [`--shape-ink-${slot}`, fill])))(
    "a shape's text %s on its fill %s meets WCAG AA",
    (text, fill) => {
      expect(contrast(hexOf(text, stack), hexOf(fill, stack))).toBeGreaterThanOrEqual(4.5);
    },
  );

  // In the Settings window, an unchecked switch's track, a box's and a field's edge are the muted text mixed into the box.
  it.each(['--raised', '--panel'])("the Settings window's switch tracks and field edges read at 3:1 on %s", (surface) => {
    const share = Number.parseFloat(scopes.get(':root')!.get('--settings-control-edge-mix')!) / 100;
    const edge = mix(hexOf('--muted', stack), hexOf('--raised', stack), share);
    expect(contrast(edge, hexOf(surface, stack))).toBeGreaterThanOrEqual(3);
  });

  it.each(COLOR_SLOTS.map((slot) => `--paint-${slot}`))('%s reads at 3:1 on the desk, as a line or large text must', (paint) => {
    expect(contrast(hexOf(paint, stack), hexOf('--surface', stack))).toBeGreaterThanOrEqual(3);
  });

  // The tab is a tint of its zone's colour with text leaning on it; a theme whose own text has no more headroom than
  // that on its panel can't be asked for more: the bar is AA, or for a pack, within half a point of its text on its panel.
  // The fill the CSS declares is the paper colour over the panel; this suite computes it the same way, so the two can't drift.
  const noteMix = () => Number.parseFloat([...stack, ':root'].map((at) => scopes.get(at)?.get('--agent-note-fill-mix')).find((v) => v !== undefined)!) / 100;
  const noteFill = () => {
    expect(scopes.get(':root')!.get('--agent-note-fill')).toBe('color-mix(in srgb, var(--agent-note-paper) var(--agent-note-fill-mix), var(--panel))');
    return mix(hexOf('--agent-note-paper', stack), hexOf('--panel', stack), noteMix());
  };
  const declared = (name: string) => Number.parseFloat([...stack, ':root'].map((at) => scopes.get(at)?.get(name)).find((v) => v !== undefined)!) / 100;

  // The card's text, muted text and links are the theme's own, or the same colours made readable on a pack's paper fill.
  it.each(['--agent-note-ink', '--agent-note-ink-muted', '--agent-note-ink-link'])("an agent note's card keeps %s at WCAG AA on its fill", (ink) => {
    expect(contrast(hexOf(ink, stack), noteFill())).toBeGreaterThanOrEqual(4.5);
  });

  it("an agent note's `code` chip and rules stay visible on the card, and its code text at AA on the chip", () => {
    if (noteMix() === 0) return; // a dark look's chip and rules are the hover and separator colours, as they were
    const [fill, ink] = [noteFill(), hexOf('--agent-note-ink', stack)];
    const chip = mix(ink, fill, declared('--agent-note-code-mix'));
    expect(contrast(chip, fill)).toBeGreaterThanOrEqual(1.1);
    expect(contrast(mix(ink, fill, declared('--agent-note-rule-mix')), fill)).toBeGreaterThanOrEqual(1.1);
    expect(contrast(ink, chip)).toBeGreaterThanOrEqual(4.5);
  });

  it('a light look keeps its note fill apart from its tile', () => {
    if (noteMix() === 0) return; // a dark look's note is the panel, darker than its tile
    expect(contrast(noteFill(), hexOf('--raised', stack))).toBeGreaterThanOrEqual(NOTE_TILE_RATIO - 0.001);
  });

  it.each([...ZONE_COLORS, 'loose'])("an agent note's tab text meets WCAG AA on a %s tab, or nearly as well as the theme's text on its panel", (zone) => {
    const share = (name: string) => Number.parseFloat([...stack, ':root'].map((at) => scopes.get(at)?.get(name)).find((v) => v !== undefined)!) / 100;
    const [panel, text] = [hexOf('--panel', stack), hexOf('--agent-note-ink', stack)];
    const tint = zone === 'loose' ? hexOf('--agent-note-loose', stack) : zone;
    const fill = mix(hexOf('--agent-note-paper', stack), panel, share('--agent-note-fill-mix'));
    const tab = mix(tint, fill, share('--agent-note-tab-mix'));
    const ink = mix(tint, text, share('--agent-note-tab-ink-mix'));
    expect(contrast(ink, tab)).toBeGreaterThanOrEqual(['light', 'dark', 'simplified', 'simplified-dark'].includes(id) ? 4.5 : Math.min(contrast(text, fill) - NOTE_TAB_ROOM, 4.5));
  });
});

// A project's well under the Simplified design: its fill and edge come from its zone's colour, and its heading, on a
// backing of the desk, stays readable at the default fill and at the slider's greatest (40%), whatever the colour.
describe.each([...SIMPLIFIED_SCOPES, ...SIMPLIFIED_PACK_SCOPES])("a project well in the $id look", ({ stack }) => {
  const share = (name: string) => Number.parseFloat([...stack, ':root'].map((at) => scopes.get(at)?.get(name)).find((v) => v !== undefined)!) / 100;
  const [surface, text] = [hexOf('--surface', stack), hexOf('--text', stack)];
  const well = (zone: string, fill: number) => mix(zone, surface, fill);

  it.each(ZONE_COLORS)("keeps its heading's text at WCAG AA on a %s well, at the default fill and at 40%", (zone) => {
    for (const fill of [share('--zone-fill-mix'), 0.4]) {
      const heading = mix(surface, well(zone, fill), share('--project-heading-backing'));
      expect(contrast(text, heading)).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The "need you" count is the status's ink, as Classic draws that status as text. The app's own looks keep it at AA
  // on the desk and on any well; a pack's ink is the pack's (tuned to its tiles), so gets the room an agent note's tab does.
  const needYouBar = SIMPLIFIED_SCOPES.some((look) => look.stack === stack) ? 4.5 : 4.5 - NOTE_TAB_ROOM;

  it('keeps its "need you" count readable on the desk', () => {
    expect(contrast(hexOf('--state-waiting-ink', stack), surface)).toBeGreaterThanOrEqual(needYouBar);
  });

  it.each(ZONE_COLORS)('keeps its "need you" count readable on a %s well, at the default fill and at 40%', (zone) => {
    const ink = hexOf('--state-waiting-ink', stack);
    for (const fill of [share('--zone-fill-mix'), 0.4]) {
      expect(contrast(ink, mix(surface, well(zone, fill), share('--project-heading-backing')))).toBeGreaterThanOrEqual(needYouBar);
    }
  });

  it.each(ZONE_COLORS)('derives a visible fill and edge from a %s zone, which differ from the desk and between colours', (zone) => {
    const [fill, edge] = [well(zone, share('--zone-fill-mix')), mix(zone, surface, share('--zone-edge-mix'))];
    expect(fill).not.toBe(surface);
    expect(contrast(edge, surface)).toBeGreaterThan(contrast(fill, surface));
    expect(well(zone, share('--zone-fill-mix'))).not.toBe(well(ZONE_COLORS.find((other) => other !== zone)!, share('--zone-fill-mix')));
  });
});

// The light theme keeps xterm's own palette; a theme that brings its own makes every colour but black, a background
// colour more than a text one, readable on its terminal's well.
describe.each(OVERRIDES)("the $id theme's terminal palette", ({ scope }) => {
  it.each(ANSI_COLOURS.filter((name) => name !== '--ansi-black'))('%s meets WCAG AA on the well', (name) => {
    expect(contrast(hexOf(name, [WINDOW, scope]), hexOf('--window-bg', [WINDOW, scope]))).toBeGreaterThanOrEqual(4.5);
  });
});

// What the chat draws beyond the window's controls: thinking, limits, removed lines and notices.
const CHAT_PAIRS = [
  ['--window-think', '--window-bg'],
  ['--window-limit', '--window-bg'],
  ['--window-removed', '--window-bg'],
  ['--window-ink', '--window-limit-soft'],
  ['--window-chat-you-ink', '--window-chat-you'],
  ['--window-ink', '--window-composer'],
  ['--window-ink', '--window-field'],
  ['--window-ink-soft', '--window-field'],
  ['--text', '--pressed'],
];

/** The Simplified decision card, in an agent's window only: its kind label and put-off line, on the composer's well. */
const CARD_PAIRS = [
  ['--window-ink-soft', '--window-composer'],
  ['--window-warning', '--window-composer'],
  ['--window-ink', '--window-composer'],
];

/** The aliases :root works out from the window's literals, which a scope that re-points the literals must work out again. */
const WINDOW_ALIASES = ['--window-divider-hover', '--window-pressed', '--window-think', '--window-limit', '--window-limit-soft', '--window-removed'];

// A chat the user chose light: the window's controls, the chat and its code read as well on the pale page.
describe('the light chat view', () => {
  it('paints its own page from the window background, as the dark window behind it is not light', () => {
    const painted = new Set<string>();
    postcss.parse(read('app.css')).walkRules((rule) => {
      rule.walkDecls('background', (decl) => {
        if (decl.value === 'var(--window-bg)') for (const each of rule.selectors) painted.add(each);
      });
    });
    expect(painted.has(".session-chat-view[data-chat-theme='light']")).toBe(true);
    expect(painted.has(".session-chat-view[data-chat-theme='match']")).toBe(true);
  });

  const LIGHT_CHAT = "[data-chat-theme='light']";
  const stack = [LIGHT_CHAT, WINDOW, ':root'];

  it.each([...WINDOW_PAIRS, ...CHAT_PAIRS, ...CARD_PAIRS])('%s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text, stack), hexOf(background, stack))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CODE_COLOURS.flatMap((name) => ['--window-bg', '--window-chrome'].map((background) => [name, background])))(
    'in a code block, %s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text, stack), hexOf(background, stack))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('works out the window aliases again from its own literals', () => {
    for (const name of WINDOW_ALIASES) expect(scopes.get(LIGHT_CHAT)?.has(name), name).toBe(true);
    expect(hexOf('--window-pressed', stack)).toBe(hexOf('--window-edge', stack));
  });
});

// The Captain's chat takes the app theme's roles, in every look the app can show.
describe.each(LOOKS)("the Captain's chat in the $id look", ({ stack: look }) => {
  const stack = ['.master-panel-chat', ...look];

  it.each([...WINDOW_PAIRS, ...CHAT_PAIRS].filter(([text, background]) => !['--text', '--text-soft', '--muted', '--placeholder', '--on-primary', '--danger'].includes(text!) || background!.startsWith('--window')))(
    '%s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text!, stack), hexOf(background!, stack))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(CODE_COLOURS.flatMap((name) => ['--window-bg', '--window-chrome'].map((background) => [name, background])))(
    'in a code block, %s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text!, stack), hexOf(background!, stack))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('works out the window aliases again from its own literals', () => {
    for (const name of WINDOW_ALIASES) expect(scopes.get('.master-panel-chat')?.has(name), name).toBe(true);
  });
});

// A chat that matches the app sits inside the dark window but reads the app theme's roles, in every look.
describe.each(LOOKS)('the matching chat in the $id look', ({ stack: look }) => {
  const stack = ["[data-chat-theme='match']", WINDOW, ...look];

  // The app's own roles (a muted label on its hover fill) are the app's to hold; the chat's own are held here.
  const OWN = [...WINDOW_PAIRS, ...CHAT_PAIRS, ...CARD_PAIRS].filter(([text, background]) => !['--text', '--text-soft', '--muted', '--placeholder', '--on-primary', '--danger'].includes(text!) || background!.startsWith('--window'));

  it.each(OWN)('%s on %s meets WCAG AA', (text, background) => {
    expect(contrast(hexOf(text!, stack), hexOf(background!, stack))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CODE_COLOURS.flatMap((name) => ['--window-bg', '--window-chrome'].map((background) => [name, background])))(
    'in a code block, %s on %s meets WCAG AA',
    (text, background) => {
      expect(contrast(hexOf(text!, stack), hexOf(background!, stack))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("is the app theme's own page, not the window's", () => {
    expect(hexOf('--window-bg', stack)).toBe(hexOf('--raised', look));
    expect(hexOf('--text', stack)).toBe(hexOf('--text', look));
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
