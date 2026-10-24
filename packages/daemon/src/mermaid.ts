// Mermaid in and out of the board: a flowchart or class diagram read into shapes and connectors, laid out in ranks the
// way Mermaid draws it, and shapes and connectors written back as Mermaid. Pure and shared, so a paste on the board
// and an agent's `diagram add` draw the same diagram, and an export reads back as what was exported. A hand-written
// reader of the two grammars' common lines, not Mermaid itself: the board needs their structure, not their drawing.
import type { Rect } from './board-layout.ts';
import { cutText } from './text-cut.ts';
import { facingSides, shapeSize } from './diagram.ts';
import {
  FILL_SLOT_COLORS,
  fillSlotOf,
  MAX_CONNECTOR_LABEL,
  MAX_TEXT_LENGTH,
  newShapeData,
  relationOf,
  SECTIONED_SHAPES,
  type ConnectorLineEnd,
  type ConnectorLook,
  type ConnectorSide,
  type FillSlot,
  type ShapeData,
  type ShapeType,
} from './protocol.ts';

/** The most shapes, and links, one diagram draws. */
export const MAX_DIAGRAM_SHAPES = 200;
export const MAX_DIAGRAM_LINKS = 500;
/** The longest Mermaid text read, and the longest line in it: a longer line is passed over. */
export const MAX_MERMAID_LENGTH = 80_000;
const MAX_LINE = 5000;

/** A line's ends, dash and labels: what a connector drawn for it looks like. */
export type LinkLook = Pick<ConnectorLook, 'startEnd' | 'endEnd' | 'dashed' | 'label' | 'startLabel' | 'endLabel'>;

/** A shape's fill as a diagram gives it: a theme slot's, a fixed colour (`fillSlot` null), or none (`fill` null). */
export interface DiagramFill {
  fill: string | null;
  fillSlot: FillSlot | null;
}

export interface DiagramShape {
  /** Its id in the Mermaid text, which its links name it by. */
  id: string;
  shape: ShapeType;
  text: string;
  /** A class's sections, a line each; empty for another kind. */
  attributes: string;
  methods: string;
  /** Its fill, when a `style` line gives one; the board's own otherwise. */
  fill?: DiagramFill;
}

/** A line between two shapes, `from` to `to` as the board draws it: a child to its parent, a whole to its parts. */
export interface DiagramLink extends LinkLook {
  from: string;
  to: string;
}

export interface Diagram {
  kind: 'flowchart' | 'class';
  /** Which way its ranks run: top to bottom, bottom to top, left to right or right to left. */
  direction: 'TB' | 'BT' | 'LR' | 'RL';
  shapes: DiagramShape[];
  links: DiagramLink[];
  /** The lines it passed over, as written: styling, clicks, notes, and what it could not read. */
  skipped: string[];
}

// Reading.

const FLOWCHART_HEADER = /^(?:flowchart|graph)(?:\s+(TB|TD|BT|LR|RL|tb|td|bt|lr|rl))?\s*;?$/;
const CLASS_HEADER = /^classDiagram(?:-v2)?\s*;?$/;

/**
 * The diagram `text` is, if it opens (past a code fence, front matter and comments) with a flowchart or class diagram
 * header; a flowchart only if a line of it has a link or a bracketed node, so a list under the word `graph` is none.
 * Throws for a diagram over `MAX_MERMAID_LENGTH`; other text that long is no diagram.
 */
export function parseMermaid(text: string): Diagram | undefined {
  const { lines, after } = meaningfulLines(text);
  const [header, ...body] = lines;
  if (header === undefined) return undefined;
  const flowchart = FLOWCHART_HEADER.exec(header);
  if (flowchart === null && !CLASS_HEADER.test(header)) return undefined;
  if (text.length > MAX_MERMAID_LENGTH) throw new Error(`a Mermaid diagram is at most ${MAX_MERMAID_LENGTH} characters`);
  const diagram = flowchart !== null ? readFlowchart(body, (flowchart[1]?.toUpperCase() ?? 'TB').replace('TD', 'TB') as Diagram['direction']) : CLASS_HEADER.test(header) ? readClassDiagram(body) : undefined;
  if (diagram === undefined) return undefined;
  return after ? { ...diagram, skipped: [...diagram.skipped, 'the text after the first diagram'] } : diagram;
}

/**
 * `text`'s lines that say something, trimmed: no code fence, front matter, directive, comment or blank. A fenced
 * diagram ends at its fence: `after` says whether anything follows it.
 */
function meaningfulLines(text: string): { lines: string[]; after: boolean } {
  let lines = text.split(/\r?\n/).map((line) => line.trim());
  let after = false;
  while (lines[0] === '') lines.shift();
  if (/^```\s*(mermaid)?$/i.test(lines[0] ?? '')) {
    lines.shift();
    const close = lines.indexOf('```');
    if (close !== -1) {
      after = lines.slice(close + 1).some((line) => line !== '');
      lines = lines.slice(0, close);
    }
  }
  while (lines[0] === '') lines.shift();
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close !== -1) lines = lines.slice(close + 1);
  }
  return { lines: lines.filter((line) => line !== '' && !line.startsWith('%%')), after };
}

/** `line` as `skipped` names it: whole, or its start for one too long to read. */
const tooLong = (line: string): string => `${line.slice(0, 40)}… (a line over ${MAX_LINE} characters)`;

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };

/** A numeric entity's character: one that is a character (no lone surrogate), else the entity as written. */
const codePoint = (whole: string, code: string): string => {
  const value = Number(code);
  return value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ? whole : String.fromCodePoint(value);
};

/** Every control character but a tab and a line break: the board's text holds none, raw or as an entity. */
const CONTROL = /(?![\t\n])\p{Cc}/gu;

/**
 * Text as Mermaid writes it, as the board shows it: entities decoded, `<br>` a new line, a Markdown string's backticks
 * gone, and no control character but a tab or a line break.
 */
function decoded(text: string): string {
  const unticked = /^`([\s\S]*)`$/.exec(text)?.[1] ?? text;
  return unticked
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#(\d{1,8});/g, codePoint)
    .replace(/#([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(CONTROL, '')
    .trim();
}

/** A quoted text's insides, decoded; unquoted text decoded as it is. */
const unquoted = (text: string): string => decoded(/^"([\s\S]*)"$/.exec(text.trim())?.[1] ?? text.trim());

/** A `style` line's fill, if it gives one: `fill:#rrggbb` (or `#rgb`), or `fill:none`. */
function styleFill(css: string): DiagramFill | undefined {
  const value = /(?:^|,)\s*fill\s*:\s*([^,;\s]+)/i.exec(css)?.[1]?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'transparent') return { fill: null, fillSlot: null };
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  const hex = short === null ? value : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(hex) ? { fill: hex, fillSlot: fillSlotOf(hex) } : undefined;
}

/**
 * A link as the board draws it: one whose ends read as a relation the other way round (`A <|-- B`, a parent before
 * its child) is turned round, its end labels with it.
 */
function canonical(link: DiagramLink): DiagramLink {
  if (relationOf(link) !== undefined) return link;
  const turned = { ...link, from: link.to, to: link.from, startEnd: link.endEnd, endEnd: link.startEnd, startLabel: link.endLabel, endLabel: link.startLabel };
  return relationOf(turned) === undefined ? link : turned;
}

const labelText = (text: string): string => cutText(text, MAX_CONNECTOR_LABEL);

/** A shape's name and sections cut to the one length they share, the name first, then the attributes, then the methods. */
function withinLength(shape: DiagramShape): DiagramShape {
  let left = MAX_TEXT_LENGTH;
  const cut = (text: string) => {
    const kept = text.length <= left ? text : left <= 1 ? '' : cutText(text, left);
    left -= kept.length;
    return kept;
  };
  return { ...shape, text: cut(shape.text), attributes: cut(shape.attributes), methods: cut(shape.methods) };
}

/**
 * A diagram's links as they are read, each once, as the board draws it. One to a shape past the shapes' limit is left
 * out uncounted (the shapes' count says it), so what is kept is bounded by the shapes that are.
 */
class Links {
  readonly kept = new Map<string, DiagramLink>();
  /** Whether any link was read, kept or not. */
  read = false;
  private readonly shapes: Shapes;

  constructor(shapes: Shapes) {
    this.shapes = shapes;
  }

  add(link: DiagramLink): void {
    this.read = true;
    if (!this.shapes.drawn(link.from) || !this.shapes.drawn(link.to)) return;
    const drawn = canonical({ ...link, label: labelText(link.label), startLabel: labelText(link.startLabel), endLabel: labelText(link.endLabel) });
    const key = JSON.stringify(drawn);
    if (!this.kept.has(key)) this.kept.set(key, drawn);
  }

  /** At most `MAX_DIAGRAM_LINKS` of the links, and a `skipped` line counting the rest. */
  done(): { links: DiagramLink[]; cut: string[] } {
    const over = this.kept.size - MAX_DIAGRAM_LINKS;
    return { links: [...this.kept.values()].slice(0, MAX_DIAGRAM_LINKS), cut: over > 0 ? [`${over} more link${over === 1 ? '' : 's'}: a diagram draws at most ${MAX_DIAGRAM_LINKS}`] : [] };
  }
}

/** The diagram read: its shapes, the links among them, and what it passed over, the limits' counts last. */
function finished(kind: Diagram['kind'], direction: Diagram['direction'], shapes: Shapes, links: Links, skipped: string[]): Diagram {
  const drawn = links.done();
  return { kind, direction, shapes: shapes.done(), links: drawn.links, skipped: [...skipped, ...shapes.cut(), ...drawn.cut] };
}

/** The diagram's shapes as they are read: each added once, at its first mention, and given a shape by its first. */
class Shapes {
  readonly byId = new Map<string, DiagramShape>();
  /** Each shape's place in the order they were first named. */
  readonly order = new Map<string, number>();
  /** The shapes given a shape and text, which a later mention leaves as they are. */
  readonly given = new Set<string>();
  readonly styles = new Map<string, DiagramFill>();

  /** Whether the shape `id` is among the first `MAX_DIAGRAM_SHAPES` named, the ones drawn. */
  drawn(id: string): boolean {
    return (this.order.get(id) ?? Infinity) < MAX_DIAGRAM_SHAPES;
  }

  /** The shape `id`, added as `fallback` if it is new. */
  get(id: string, fallback: ShapeType): DiagramShape {
    let shape = this.byId.get(id);
    if (shape === undefined) {
      shape = { id, shape: fallback, text: id, attributes: '', methods: '' };
      this.order.set(id, this.byId.size);
      this.byId.set(id, shape);
    }
    return shape;
  }

  /** What `done` leaves out, as a line of a diagram's `skipped`. */
  cut(): string[] {
    const over = this.byId.size - MAX_DIAGRAM_SHAPES;
    return over > 0 ? [`${over} more shape${over === 1 ? '' : 's'}: a diagram draws at most ${MAX_DIAGRAM_SHAPES}`] : [];
  }

  /** The shapes, in the order they were first named, each with its style's fill: at most `MAX_DIAGRAM_SHAPES`. */
  done(): DiagramShape[] {
    return [...this.byId.values()].slice(0, MAX_DIAGRAM_SHAPES).map((shape) => {
      const fill = this.styles.get(shape.id);
      return { ...withinLength(shape), ...(fill === undefined ? {} : { fill }) };
    });
  }
}

// Flowcharts.

/** Each bracket pair a flowchart node's text can sit in, and the shape it draws: the longest openers first. */
const BRACKETS: readonly [open: string, close: string, shape: ShapeType][] = [
  ['(((', ')))', 'ellipse'],
  ['([', '])', 'terminator'],
  ['[[', ']]', 'predefined-process'],
  ['[(', ')]', 'database'],
  ['((', '))', 'ellipse'],
  ['{{', '}}', 'preparation'],
  ['[/', '/]', 'input-output'],
  ['[/', '\\]', 'manual-input'],
  ['[\\', '\\]', 'input-output'],
  ['[\\', '/]', 'manual-input'],
  ['>', ']', 'rectangle'],
  ['(', ')', 'rounded'],
  ['[', ']', 'rectangle'],
  ['{', '}', 'diamond'],
];

/** The shapes of Mermaid's `@{ shape: … }` the board has, by each of their names. */
const SHAPE_NAMES: Record<string, ShapeType> = Object.fromEntries(
  (
    [
      ['rectangle', ['rect', 'rectangle', 'proc', 'process', 'flag', 'paper-tape', 'odd']],
      ['rounded', ['rounded', 'event']],
      ['terminator', ['stadium', 'pill', 'terminal']],
      ['predefined-process', ['subproc', 'subroutine', 'subprocess', 'fr-rect', 'framed-rectangle']],
      ['database', ['cyl', 'cylinder', 'database', 'db']],
      ['ellipse', ['circle', 'circ', 'dbl-circ', 'double-circle']],
      ['diamond', ['diam', 'diamond', 'decision', 'question']],
      ['preparation', ['hex', 'hexagon', 'prepare']],
      ['input-output', ['lean-r', 'lean-right', 'in-out', 'lean-l', 'lean-left', 'out-in']],
      ['manual-input', ['sl-rect', 'sloped-rectangle', 'manual-input', 'trap-b', 'trapezoid-bottom', 'priority', 'trap-t', 'trapezoid-top', 'manual', 'inv-trapezoid']],
      ['document', ['doc', 'document']],
      ['multi-document', ['docs', 'documents', 'st-doc', 'stacked-document']],
      ['delay', ['delay', 'half-rounded-rectangle']],
      ['loop-limit', ['notch-pent', 'loop-limit', 'notched-pentagon']],
      ['cloud', ['cloud']],
      ['queue', ['h-cyl', 'horizontal-cylinder', 'das']],
      ['storage', ['lin-cyl', 'disk', 'lined-cylinder']],
      ['start', ['sm-circ', 'start', 'small-circle']],
      ['end', ['fr-circ', 'stop', 'framed-circle']],
      ['fork-join', ['fork', 'join']],
      ['circle-connector', ['f-circ', 'filled-circle', 'junction']],
    ] as const
  ).flatMap(([shape, names]) => names.map((name) => [name, shape])),
);

const NODE_ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u;

/** What a flowchart line names: its groups of nodes, each with what it is given, and the link after each but the last. */
interface FlowStatement {
  groups: { id: string; shape?: ShapeType; text?: string }[][];
  looks: LinkLook[];
}

/** A reader along one flowchart statement. */
class Cursor {
  at = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  get rest(): string {
    return this.text.slice(this.at);
  }

  skipSpace(): void {
    while (/\s/.test(this.text[this.at] ?? '')) this.at += 1;
  }

  /** Reads `pattern` here, if it matches, moving past it. */
  take(pattern: RegExp): RegExpExecArray | undefined {
    const match = pattern.exec(this.rest);
    if (match === null) return undefined;
    this.at += match[0].length;
    return match;
  }
}

/** A node's bracketed text and shape, read at `cursor`; undefined (the cursor left alone) for none there. */
function readBrackets(cursor: Cursor): { shape: ShapeType; text: string } | undefined {
  for (const [open] of BRACKETS) {
    if (!cursor.rest.startsWith(open)) continue;
    const closers = BRACKETS.filter((each) => each[0] === open);
    const start = cursor.at + open.length;
    const body = cursor.text.slice(start);
    const quoted = /^\s*"([^"]*)"\s*/.exec(body);
    const found = closers
      .map(([, close, shape]) => ({ close, shape, index: quoted === null ? body.indexOf(close) : body.startsWith(close, quoted[0].length) ? quoted[0].length : -1 }))
      .filter(({ index }) => index !== -1)
      .sort((a, b) => a.index - b.index)[0];
    if (found === undefined) return undefined;
    cursor.at = start + found.index + found.close.length;
    return { shape: found.shape, text: decoded(quoted === null ? body.slice(0, found.index) : quoted[1]!) };
  }
  return undefined;
}

/** A node's `@{ shape: …, label: … }`, read at `cursor`. */
function readShapeData(cursor: Cursor): { shape?: ShapeType; text?: string } | undefined {
  const match = cursor.take(/^@\{((?:[^}"]|"[^"]*")*)\}/);
  if (match === undefined) return undefined;
  const fields = Object.fromEntries(
    [...match[1]!.matchAll(/([\w-]+)\s*:\s*("[^"]*"|[^,]*)/g)].map(([, key, value]) => [key!.toLowerCase(), unquoted(value!)]),
  );
  const shape = fields.shape === undefined ? undefined : SHAPE_NAMES[fields.shape.toLowerCase()];
  return { ...(shape === undefined ? {} : { shape }), ...(fields.label === undefined ? {} : { text: fields.label }) };
}

/** A node at `cursor`: its id, then any shape and text, then any `:::class`. */
function readNode(cursor: Cursor): FlowStatement['groups'][number][number] | undefined {
  cursor.skipSpace();
  const id = cursor.take(NODE_ID)?.[0];
  if (id === undefined) return undefined;
  const given = readShapeData(cursor) ?? readBrackets(cursor) ?? {};
  cursor.take(/^:::[\w-]+/);
  return { id, ...given };
}

/** The nodes at `cursor` joined by `&`. */
function readGroup(cursor: Cursor): FlowStatement['groups'][number] | undefined {
  const first = readNode(cursor);
  if (first === undefined) return undefined;
  const group = [first];
  for (;;) {
    const before = cursor.at;
    cursor.skipSpace();
    if (cursor.take(/^&/) === undefined) {
      cursor.at = before;
      return group;
    }
    const next = readNode(cursor);
    if (next === undefined) return undefined;
    group.push(next);
  }
}

const FLOW_START_END: Record<string, ConnectorLineEnd> = { '<': 'arrow', o: 'dot', x: 'arrow' };
const FLOW_END: Record<string, ConnectorLineEnd> = { '>': 'arrow', o: 'dot', x: 'arrow' };
/** The start of a link with its text in the line, `-- text -->`, `-. text .->`, `== text ==>`, and its end. */
const TEXT_LINK_OPEN = /^([<ox])?(--|==|-\.)/;
const TEXT_LINK_CLOSE = /(-{2,}|={2,}|\.-+)(>|[ox](?![\p{L}\p{N}_]))?/gu;
/** A link without: `-->`, `---`, `-.->`, `==>`, `<-->`, `--o`. */
// An `o` or `x` straight after the line is its end, as Mermaid reads `C--oD`: a node's name is never joined to a line.
const LINK = /^([<ox])?(-{2,}|={2,}|-\.+-)([>ox])?/u;

/**
 * A link with its text in the line, read at `cursor`: its opening line, then the text (from its first character that
 * is no space), then the first closing line after that. Found by a scan, not one pattern, which would try every way of
 * sharing a run of spaces between the text and the room round it.
 */
function readTextLink(cursor: Cursor): { start?: string; line: string; end?: string; label: string } | undefined {
  const open = TEXT_LINK_OPEN.exec(cursor.rest);
  if (open === null) return undefined;
  const after = cursor.at + open[0].length;
  const next = cursor.text[after] ?? '';
  // `-->`, `---`, `-.->`, `==>` and `--o` are links without text.
  if (next === '' || (!/\s/.test(next) && '-=.>ox'.includes(next))) return undefined;
  let from = after;
  while (/\s/.test(cursor.text[from] ?? '')) from += 1;
  if (from >= cursor.text.length) return undefined;
  TEXT_LINK_CLOSE.lastIndex = from + 1;
  const close = TEXT_LINK_CLOSE.exec(cursor.text);
  if (close === null) return undefined;
  cursor.at = close.index + close[0].length;
  return { start: open[1], line: open[2]!, end: close[2], label: decoded(cursor.text.slice(from, close.index)) };
}

/** A link at `cursor`, and its label between pipes after it. */
function readLink(cursor: Cursor): LinkLook | undefined {
  cursor.skipSpace();
  const withText = readTextLink(cursor);
  const before = cursor.at;
  let plain = withText === undefined ? cursor.take(LINK) : undefined;
  // `--` or `==` alone, with no end either side, is no flowchart link.
  if (plain !== undefined && (plain[2] === '--' || plain[2] === '==') && plain[1] === undefined && plain[3] === undefined) {
    cursor.at = before;
    plain = undefined;
  }
  if (withText === undefined && plain === undefined) return undefined;
  const { start, line, end } = withText ?? { start: plain![1], line: plain![2]!, end: plain![3] };
  let label = withText?.label ?? '';
  cursor.skipSpace();
  const piped = cursor.take(/^\|((?:[^|"]|"[^"]*")*)\|/);
  if (piped !== undefined) label = unquoted(piped[1]!);
  return {
    startEnd: start === undefined ? 'none' : FLOW_START_END[start]!,
    endEnd: end === undefined ? 'none' : FLOW_END[end]!,
    dashed: line.startsWith('-.'),
    label,
    startLabel: '',
    endLabel: '',
  };
}

/** A flowchart statement's nodes and links: a chain of groups joined by links; undefined if it is not one. */
function readFlowStatement(text: string): FlowStatement | undefined {
  const cursor = new Cursor(text);
  const groups = [readGroup(cursor)];
  const looks: LinkLook[] = [];
  for (;;) {
    const look = readLink(cursor);
    if (look === undefined) break;
    looks.push(look);
    groups.push(readGroup(cursor));
  }
  cursor.skipSpace();
  if (cursor.rest !== '' || groups.some((group) => group === undefined)) return undefined;
  return { groups: groups as FlowStatement['groups'], looks };
}

/** `line` split at each `;` that ends a statement: not one in quotes or brackets, nor one ending an entity. */
function statements(line: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let depth = 0;
  let start = 0;
  for (let n = 0; n < line.length; n += 1) {
    const char = line[n]!;
    if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ('[({'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0 && !/#\w+$/.test(line.slice(start, n))) {
      parts.push(line.slice(start, n).trim());
      start = n + 1;
    }
  }
  parts.push(line.slice(start).trim());
  return parts.filter((part) => part !== '');
}

function readFlowchart(lines: string[], direction: Diagram['direction']): Diagram | undefined {
  const shapes = new Shapes();
  const links = new Links(shapes);
  const skipped: string[] = [];
  const read = lines.flatMap((line) => {
    if (line.length <= MAX_LINE) return statements(line);
    skipped.push(tooLong(line));
    return [];
  });
  for (const statement of read) {
    // A subgraph's nodes are drawn loose, without its box.
    if (/^(subgraph\b|end$|direction\s)/.test(statement)) continue;
    const style = /^style\s+(\S+)\s+(.*)$/.exec(statement);
    if (style !== null) {
      const fill = styleFill(style[2]!);
      if (fill === undefined) skipped.push(statement);
      else shapes.styles.set(style[1]!, fill);
      continue;
    }
    const flow = /^(classDef|class|click|linkStyle)\s/.test(statement) ? undefined : readFlowStatement(statement);
    if (flow === undefined) {
      skipped.push(statement);
      continue;
    }
    for (const node of flow.groups.flat()) {
      const shape = shapes.get(node.id, node.shape ?? 'rectangle');
      if (shapes.given.has(node.id) || (node.shape === undefined && node.text === undefined)) continue;
      Object.assign(shape, { shape: node.shape ?? shape.shape, text: node.text ?? node.id });
      shapes.given.add(node.id);
    }
    flow.looks.forEach((look, n) => {
      for (const from of flow.groups[n]!) for (const to of flow.groups[n + 1]!) links.add({ from: from.id, to: to.id, ...look });
    });
  }
  // A list under the word `graph` is no diagram: one has a bracketed node, a link or a style.
  if (shapes.given.size === 0 && !links.read && shapes.styles.size === 0) return undefined;
  return finished('flowchart', direction, shapes, links, skipped);
}

// Class diagrams.

const CLASS_NAME = '([\\p{L}\\p{N}_]+)(?:~([^~]+)~)?';
const CLASS_DECLARATION = new RegExp(`^class\\s+${CLASS_NAME}(?:\\s*\\["([^"]*)"\\])?(?::::[\\w-]+)?\\s*(\\{)?\\s*(\\})?$`, 'u');
const ANNOTATION = new RegExp(`^<<\\s*([^>]+?)\\s*>>\\s*${CLASS_NAME}$`, 'u');
const RELATION = new RegExp(`^${CLASS_NAME}\\s*(?:"([^"]*)"\\s*)?(<\\||\\*|o|<)?(--|\\.\\.)(\\|>|\\*|o|>)?\\s*(?:"([^"]*)"\\s*)?${CLASS_NAME}\\s*(?::\\s*(.*))?$`, 'u');
const MEMBER = new RegExp(`^${CLASS_NAME}\\s*:\\s*(.+)$`, 'u');

const CLASS_START: Record<string, ConnectorLineEnd> = { '<|': 'triangle', '*': 'filled-diamond', o: 'diamond', '<': 'arrow' };
const CLASS_END: Record<string, ConnectorLineEnd> = { '|>': 'triangle', '*': 'filled-diamond', o: 'diamond', '>': 'arrow' };

/** A class member as the board shows it: Mermaid's generics, `List~Line~`, in angle brackets. */
const memberText = (text: string): string => decoded(text).replace(/~([^~]+)~/g, '<$1>');

function readClassDiagram(lines: string[]): Diagram {
  const shapes = new Shapes();
  const classes = new Map<string, { generic?: string; label?: string; annotation?: string }>();
  const links = new Links(shapes);
  const skipped: string[] = [];
  let direction: Diagram['direction'] = 'TB';
  /** The class whose block the lines are in, and how deep in namespaces they are. */
  let block: string | undefined;
  let namespaces = 0;
  const known = (id: string, generic?: string) => {
    const shape = shapes.get(id, 'class');
    const info = classes.get(id) ?? {};
    if (generic !== undefined) info.generic ??= generic;
    classes.set(id, info);
    return { shape, info };
  };
  const addMember = (id: string, line: string) => {
    const { shape } = known(id);
    const section = line.includes('(') ? 'methods' : 'attributes';
    shape[section] = shape[section] === '' ? memberText(line) : `${shape[section]}\n${memberText(line)}`;
  };
  for (const line of lines) {
    if (line.length > MAX_LINE) {
      skipped.push(tooLong(line));
      continue;
    }
    if (block !== undefined) {
      if (line === '}') block = undefined;
      else {
        const annotation = /^<<\s*([^>]+?)\s*>>$/.exec(line);
        if (annotation !== null) known(block).info.annotation = annotation[1]!;
        else addMember(block, line);
      }
      continue;
    }
    const turned = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(line);
    if (turned !== null) {
      direction = turned[1]!.toUpperCase().replace('TD', 'TB') as Diagram['direction'];
      continue;
    }
    if (/^namespace\s+\S+\s*\{$/.test(line)) {
      namespaces += 1;
      continue;
    }
    if (line === '}' && namespaces > 0) {
      namespaces -= 1;
      continue;
    }
    const declared = CLASS_DECLARATION.exec(line);
    if (declared !== null) {
      const [, id, generic, label, open, close] = declared;
      const { info } = known(id!, generic);
      if (label !== undefined) info.label = decoded(label);
      if (open !== undefined && close === undefined) block = id;
      continue;
    }
    const annotated = ANNOTATION.exec(line);
    if (annotated !== null) {
      known(annotated[2]!, annotated[3]).info.annotation = annotated[1]!;
      continue;
    }
    const related = RELATION.exec(line);
    if (related !== null) {
      const [, from, fromGeneric, startLabel, start, dash, end, endLabel, to, toGeneric, label] = related;
      known(from!, fromGeneric);
      known(to!, toGeneric);
      links.add({
        from: from!,
        to: to!,
        startEnd: start === undefined ? 'none' : CLASS_START[start]!,
        endEnd: end === undefined ? 'none' : CLASS_END[end]!,
        dashed: dash === '..',
        label: label === undefined ? '' : decoded(label),
        startLabel: startLabel === undefined ? '' : decoded(startLabel),
        endLabel: endLabel === undefined ? '' : decoded(endLabel),
      });
      continue;
    }
    const member = MEMBER.exec(line);
    if (member !== null) {
      known(member[1]!, member[2]);
      addMember(member[1]!, member[3]!);
      continue;
    }
    const style = /^style\s+(\S+)\s+(.*)$/.exec(line);
    const fill = style === null ? undefined : styleFill(style[2]!);
    if (fill !== undefined) shapes.styles.set(style![1]!, fill);
    else skipped.push(line);
  }
  for (const [id, { generic, label, annotation }] of classes) {
    const shape = shapes.get(id, 'class');
    const name = label ?? (generic === undefined ? id : `${id}<${memberText(generic)}>`);
    const stereotype = annotation === undefined ? undefined : decoded(annotation);
    const isInterface = stereotype?.toLowerCase() === 'interface';
    Object.assign(shape, { shape: isInterface ? 'interface-box' : 'class', text: stereotype === undefined || stereotype === '' || isInterface ? name : `«${stereotype}»\n${name}` });
  }
  return finished('class', direction, shapes, links, skipped);
}

// Laying out.

/** A diagram's shape placed on the board, from the diagram's top-left, with the data the board draws it with. */
export interface PlacedShape extends Rect {
  /** Its id in the diagram. */
  key: string;
  data: ShapeData;
}

/** A connector between two placed shapes, on the sides of each that face the other. */
export interface PlacedLink {
  from: { key: string; side: ConnectorSide };
  to: { key: string; side: ConnectorSide };
  look: LinkLook;
}

/** The room between two ranks of a diagram, and between two shapes in a rank, px. */
const RANK_GAP = 96;
const SHAPE_GAP = 64;

/**
 * `diagram` laid out the way Mermaid draws one, from 0,0: in ranks along its direction, each shape a rank past the
 * shapes it comes after (a parent class before its children, a whole before its parts), ordered in its rank to keep
 * lines from crossing, and each rank centred on the widest. A link from a shape to itself is left out.
 */
export function layOutDiagram(diagram: Diagram): { shapes: PlacedShape[]; links: PlacedLink[]; width: number; height: number } {
  const ids = diagram.shapes.map(({ id }) => id);
  const links = diagram.links.filter(({ from, to }) => from !== to);
  const edges = links.map((link) => (link.endEnd === 'triangle' ? [link.to, link.from] : [link.from, link.to]) as [string, string]);
  const ranks = rankOf(ids, edges);
  const rows: string[][] = [];
  for (const id of ids) (rows[ranks.get(id)!] ??= []).push(id);
  orderRows(rows, edges);
  if (diagram.direction === 'BT' || diagram.direction === 'RL') rows.reverse();

  const data = new Map(diagram.shapes.map(({ id, shape, text, attributes, methods, fill }) => [id, { ...newShapeData(shape), text, attributes, methods, ...fill }]));
  const sizes = new Map([...data].map(([id, each]) => [id, shapeSize(each)]));
  const across = diagram.direction === 'LR' || diagram.direction === 'RL';
  // Along: the axis the ranks follow each other on; side: the one a rank's shapes sit side by side on.
  const along = (id: string) => (across ? sizes.get(id)!.width : sizes.get(id)!.height);
  const side = (id: string) => (across ? sizes.get(id)!.height : sizes.get(id)!.width);
  const rowLength = (row: string[]) => row.reduce((sum, id) => sum + side(id), 0) + SHAPE_GAP * (row.length - 1);
  const widest = Math.max(0, ...rows.map(rowLength));
  const rects = new Map<string, Rect>();
  let rankStart = 0;
  for (const row of rows) {
    const depth = Math.max(...row.map(along));
    let offset = (widest - rowLength(row)) / 2;
    for (const id of row) {
      const a = rankStart + (depth - along(id)) / 2;
      const { width, height } = sizes.get(id)!;
      rects.set(id, across ? { x: Math.round(a), y: Math.round(offset), width, height } : { x: Math.round(offset), y: Math.round(a), width, height });
      offset += side(id) + SHAPE_GAP;
    }
    rankStart += depth + RANK_GAP;
  }
  const shapes = ids.map((id) => ({ key: id, ...rects.get(id)!, data: data.get(id)! }));
  return {
    shapes,
    links: links.map(({ from, to, ...look }) => {
      const sides = facingSides(rects.get(from)!, rects.get(to)!);
      return { from: { key: from, side: sides.from }, to: { key: to, side: sides.to }, look };
    }),
    width: Math.max(0, ...shapes.map(({ x, width }) => x + width)),
    height: Math.max(0, ...shapes.map(({ y, height }) => y + height)),
  };
}

/** Each shape's rank: one past the furthest of those before it, a cycle broken at the edge that closes it. */
function rankOf(ids: string[], edges: [string, string][]): Map<string, number> {
  const after = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [upper, lower] of edges) after.get(upper)!.push(lower);
  // A depth-first walk in the order the shapes were named keeps the edges that don't close a cycle.
  const kept = new Map(ids.map((id) => [id, [] as string[]]));
  const state = new Map<string, 'open' | 'done'>();
  const walk = (id: string) => {
    state.set(id, 'open');
    for (const next of after.get(id)!) {
      if (state.get(next) === 'open') continue;
      kept.get(id)!.push(next);
      if (state.get(next) === undefined) walk(next);
    }
    state.set(id, 'done');
  };
  for (const id of ids) if (state.get(id) === undefined) walk(id);
  const ranks = new Map(ids.map((id) => [id, 0]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const nexts of kept.values()) for (const next of nexts) incoming.set(next, incoming.get(next)! + 1);
  const ready = ids.filter((id) => incoming.get(id) === 0);
  while (ready.length > 0) {
    const id = ready.shift()!;
    for (const next of kept.get(id)!) {
      ranks.set(next, Math.max(ranks.get(next)!, ranks.get(id)! + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) ready.push(next);
    }
  }
  return ranks;
}

/** Orders each row by where its shapes' neighbours in the row before (then after) are, a few times over. */
function orderRows(rows: string[][], edges: [string, string][]): void {
  const neighbours = (id: string, row: string[] | undefined) =>
    row === undefined ? [] : edges.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : [])).map((other) => row.indexOf(other)).filter((index) => index !== -1);
  const sortBy = (row: string[], by: string[] | undefined) => {
    const keys = new Map(row.map((id, index) => [id, ((list) => (list.length === 0 ? index : list.reduce((sum, each) => sum + each, 0) / list.length))(neighbours(id, by))]));
    row.sort((a, b) => keys.get(a)! - keys.get(b)!);
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let r = 1; r < rows.length; r += 1) sortBy(rows[r]!, rows[r - 1]);
    for (let r = rows.length - 2; r >= 0; r -= 1) sortBy(rows[r]!, rows[r + 1]);
  }
}

// Writing.

/** A board shape to export: its id and data. */
export interface ExportShape {
  id: string;
  data: Pick<ShapeData, 'shape' | 'text' | 'attributes' | 'methods' | 'fill'> & { fillSlot?: FillSlot | null };
}
/** A board connector to export: what it joins, on which sides, and its look. */
export type ExportConnector = { from: { id: string; side: ConnectorSide }; to: { id: string; side: ConnectorSide } } & LinkLook;

/** The board shapes Mermaid's flowchart brackets draw, by each. */
const FLOW_BRACKETS: Partial<Record<ShapeType, [string, string]>> = {
  rectangle: ['[', ']'],
  rounded: ['(', ')'],
  terminator: ['([', '])'],
  'predefined-process': ['[[', ']]'],
  database: ['[(', ')]'],
  ellipse: ['((', '))'],
  diamond: ['{', '}'],
  preparation: ['{{', '}}'],
  'input-output': ['[/', '/]'],
  // Mermaid has none of these; each goes as the shape nearest it.
  state: ['(', ')'],
  choice: ['{', '}'],
  'use-case': ['((', '))'],
};
/** The board shapes only Mermaid's `@{ shape: … }` draws, by its name for each. */
const FLOW_SHAPE_NAMES: Partial<Record<ShapeType, string>> = {
  document: 'doc',
  'multi-document': 'docs',
  delay: 'delay',
  'loop-limit': 'notch-pent',
  cloud: 'cloud',
  queue: 'h-cyl',
  storage: 'lin-cyl',
  start: 'sm-circ',
  end: 'fr-circ',
  'fork-join': 'fork',
  'manual-input': 'sl-rect',
  'circle-connector': 'f-circ',
};

const CLASS_ENDS: readonly ConnectorLineEnd[] = ['triangle', 'diamond', 'filled-diamond'];

/**
 * `shapes` and the connectors among them as Mermaid: a class diagram when a class is among them or a connector has a
 * class diagram's end, else a flowchart; running left to right when most connectors leave their shapes' sides. What
 * Mermaid has no way to say is left out: a flowchart's end labels, a shape's outline and text style, and a kind of
 * shape it lacks, which goes as a rectangle.
 */
export function toMermaid(shapes: readonly ExportShape[], connectors: readonly ExportConnector[]): string {
  const ids = new Set(shapes.map(({ id }) => id));
  const among = connectors.filter(({ from, to }) => ids.has(from.id) && ids.has(to.id));
  const sideways = among.filter(({ from }) => from.side === 'left' || from.side === 'right').length;
  const across = sideways > among.length - sideways;
  const isClass = shapes.some(({ data }) => SECTIONED_SHAPES.includes(data.shape)) || among.some(({ startEnd, endEnd }) => CLASS_ENDS.includes(startEnd) || CLASS_ENDS.includes(endEnd));
  const lines = isClass ? classLines(shapes, among, across) : flowLines(shapes, among, across);
  return `${lines.join('\n')}\n`;
}

/** Text in quotes as Mermaid reads it back: quotes, pipes and what would read as an entity escaped, lines `<br>`. */
const quoted = (text: string): string => `"${escaped(text).replace(/\|/g, '#124;')}"`;
const escaped = (text: string): string => text.replace(/#(?=[\p{L}\p{N}]+;)/gu, '#35;').replace(/"/g, '#quot;').replace(/\n/g, '<br>');

/** The `style` lines for the shapes whose fill is not the board's own, by the id each is written as. */
function styleLines(shapes: readonly ExportShape[], idOf: (shape: ExportShape) => string): string[] {
  return shapes.flatMap((shape) => {
    const { fill } = shape.data;
    const slot = shape.data.fillSlot !== undefined ? shape.data.fillSlot : fill === null ? null : fillSlotOf(fill);
    if (slot === 'tile') return [];
    return [`  style ${idOf(shape)} fill:${fill === null ? 'none' : slot === null ? fill : FILL_SLOT_COLORS[slot]}`];
  });
}

function flowLines(shapes: readonly ExportShape[], connectors: readonly ExportConnector[], across: boolean): string[] {
  const names = new Map(shapes.map(({ id }, n) => [id, `n${n + 1}`]));
  const idOf = ({ id }: { id: string }) => names.get(id)!;
  const nodes = shapes.map((shape) => {
    const { shape: kind, text } = shape.data;
    const named = FLOW_SHAPE_NAMES[kind];
    if (named !== undefined) return `  ${idOf(shape)}@{ shape: ${named}, label: ${quoted(text)} }`;
    const [open, close] = FLOW_BRACKETS[kind] ?? FLOW_BRACKETS.rectangle!;
    return `  ${idOf(shape)}${open}${quoted(text)}${close}`;
  });
  const flowEnd = (end: ConnectorLineEnd, arrow: string) => (end === 'arrow' ? arrow : end === 'dot' ? 'o' : '');
  const links = connectors.map(({ from, to, startEnd, endEnd, dashed, label }) => {
    const [start, end] = [flowEnd(startEnd, '<'), flowEnd(endEnd, '>')];
    const line = `${start}${dashed ? '-.-' : end === '' ? '---' : '--'}${end}`;
    return `  ${names.get(from.id)} ${line}${label === '' ? '' : `|${quoted(label)}|`} ${names.get(to.id)}`;
  });
  return [`flowchart ${across ? 'LR' : 'TD'}`, ...nodes, ...links, ...styleLines(shapes, idOf)];
}

const STEREOTYPE = /^\s*(?:«([^»\n]*)»|<<([^>\n]*)>>)\s*$/;
const CLASS_START_OUT: Partial<Record<ConnectorLineEnd, string>> = { triangle: '<|', 'filled-diamond': '*', diamond: 'o', arrow: '<' };
const CLASS_END_OUT: Partial<Record<ConnectorLineEnd, string>> = { triangle: '|>', 'filled-diamond': '*', diamond: 'o', arrow: '>' };
/**
 * A member as Mermaid writes it: angle-bracketed generics as `~Line~`, and one that would read as something else (an
 * entity, the block's closing brace, an annotation) escaped.
 */
const mermaidMember = (line: string): string => {
  const written = line.replace(/#(?=[\p{L}\p{N}]+;)/gu, '#35;').replace(/<([^<>]+)>/g, '~$1~');
  if (written.trim() === '}') return '#125;';
  return /^\s*<</.test(written) ? written.replace('<', '#lt;') : written;
};

function classLines(shapes: readonly ExportShape[], connectors: readonly ExportConnector[], across: boolean): string[] {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  const declarations = shapes.flatMap((shape) => {
    const [first = '', ...rest] = shape.data.text.split('\n');
    const marked = STEREOTYPE.exec(first);
    const stereotype = marked === null ? (shape.data.shape === 'interface-box' ? 'interface' : undefined) : (marked[1] ?? marked[2])!.trim();
    const name = (marked === null ? shape.data.text : rest.join('\n')).trim();
    const generic = /^([\p{L}\p{N}_]+)<(.+)>$/u.exec(name);
    const base = generic?.[1] ?? name;
    let id = base.replace(/[^\p{L}\p{N}_]/gu, '_') || 'Class';
    for (let n = 2; taken.has(id); n += 1) id = `${base.replace(/[^\p{L}\p{N}_]/gu, '_') || 'Class'}_${n}`;
    taken.add(id);
    names.set(shape.id, id);
    const head = generic !== null ? `class ${id}~${generic[2]}~` : id === name ? `class ${id}` : `class ${id}[${quoted(name)}]`;
    const members = [...(stereotype === undefined ? [] : [`<<${stereotype}>>`]), ...[shape.data.attributes, shape.data.methods].flatMap((section) => (section === '' ? [] : section.split('\n').map(mermaidMember)))];
    return members.length === 0 ? [`  ${head}`] : [`  ${head} {`, ...members.map((member) => `    ${member}`), '  }'];
  });
  const relations = connectors.map(({ from, to, startEnd, endEnd, dashed, label, startLabel, endLabel }) => {
    const card = (text: string) => (text === '' ? '' : `${quoted(text)} `);
    const arrow = `${CLASS_START_OUT[startEnd] ?? ''}${dashed ? '..' : '--'}${CLASS_END_OUT[endEnd] ?? ''}`;
    return `  ${names.get(from.id)} ${card(startLabel)}${arrow} ${card(endLabel)}${names.get(to.id)}${label === '' ? '' : ` : ${escaped(label)}`}`;
  });
  return ['classDiagram', ...(across ? ['  direction LR'] : []), ...declarations, ...relations, ...styleLines(shapes, ({ id }) => names.get(id)!)];
}
