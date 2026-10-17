// The shapes: each one's name, group, other words for it, size and drawing.
import { SHAPE_TYPES, type ShapeType } from '@agent-board/daemon/protocol';
import { closed, fitParts, type Box, type Fit, type MockPart, type ShapePart } from './geometry';

export type ShapeGroup = 'flowchart' | 'architecture' | 'uml';

/** The picker's groups, in order. */
export const SHAPE_GROUPS: readonly { id: ShapeGroup; name: string }[] = [
  { id: 'flowchart', name: 'Flowchart' },
  { id: 'architecture', name: 'Architecture' },
  { id: 'uml', name: 'UML' },
];

/** Where a shape's text goes, as fractions of its box in from each side. */
export interface LabelBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** At the top of that box rather than its middle, as a group's title is. */
  atTop?: boolean;
  /** Without the usual padding: the box is already well inside the outline, as a diamond's is. */
  tight?: boolean;
  /** Outside the outline, on the board, as a figure's name is: inked as text on the board, not on the fill. */
  outside?: boolean;
}

export interface ShapeKind {
  /** As the picker and the bar name it. */
  name: string;
  group: ShapeGroup;
  /** Other words for it, which search matches too: "db" finds Database. */
  synonyms: readonly string[];
  /** Its size when placed with a click. */
  size: { width: number; height: number };
  label: LabelBox;
  /** Its parts in `box`, the node's box inset by half the stroke so the outline meets the edges. */
  draw(box: Box): ShapePart[];
}

/** A shape's size when one isn't given. */
export const DEFAULT_SHAPE_SIZE = { width: 240, height: 140 };

const WHOLE: LabelBox = { top: 0, right: 0, bottom: 0, left: 0 };
const inset = (top: number, right = top, bottom = top, left = right): LabelBox => ({ top, right, bottom, left });

/**
 * Text under a figure, or under a solid mark whose ink is the stroke's (Start, End, Fork / join): the mark takes the top
 * of the box, the text this share of it at the bottom, on the board.
 */
const UNDER = 0.28;
const underFigure: LabelBox = { top: 1 - UNDER, right: 0, bottom: 0, left: 0, tight: true, outside: true };
const aboveText = (box: Box): Box => ({ ...box, height: box.height * (1 - UNDER) });

/** A shape drawn from the mock's parts, mapped onto `frame` of its cell. */
const mock =
  (frame: readonly [number, number, number, number], parts: readonly MockPart[], fit: Fit = 'stretch', area: (box: Box) => Box = (box) => box) =>
  (box: Box) =>
    fitParts(parts, frame, fit, area(box));

const s = 'shape' as const;
const l = 'line' as const;
const k = 'solid' as const;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** An ellipse filling the box, its text inside: Ellipse and Use case. */
const OVAL = {
  label: inset(0.146),
  draw: (b: Box): ShapePart[] => [{ el: 'ellipse', ink: s, cx: b.x + b.width / 2, cy: b.y + b.height / 2, rx: b.width / 2, ry: b.height / 2 }],
};

/** A diamond touching the middle of each side, its text inside: Decision and Choice. */
const RHOMBUS = {
  label: { ...inset(0.25), tight: true },
  draw: (b: Box): ShapePart[] => [
    {
      el: 'path',
      ink: s,
      d: closed([
        [b.x + b.width / 2, b.y],
        [b.x + b.width, b.y + b.height / 2],
        [b.x + b.width / 2, b.y + b.height],
        [b.x, b.y + b.height / 2],
      ]),
    },
  ],
};

type Kinds = Record<ShapeType, Omit<ShapeKind, 'size'> & { size?: ShapeKind['size'] }>;

const KINDS: Kinds = {
  // Flowchart. The first four are the shapes from before, drawn as they were.
  rectangle: {
    name: 'Process',
    group: 'flowchart',
    synonyms: ['rectangle', 'box', 'step', 'task'],
    label: WHOLE,
    draw: (b) => [{ el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: b.height }],
  },
  rounded: {
    name: 'Rounded',
    group: 'flowchart',
    synonyms: ['rounded rectangle', 'card', 'activity'],
    label: WHOLE,
    draw: (b) => [{ el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: b.height, round: true }],
  },
  ellipse: {
    name: 'Ellipse',
    group: 'flowchart',
    synonyms: ['oval', 'circle'],
    ...OVAL,
  },
  diamond: {
    name: 'Decision',
    group: 'flowchart',
    synonyms: ['diamond', 'if', 'branch', 'condition', 'question'],
    ...RHOMBUS,
  },
  terminator: {
    name: 'Terminator',
    group: 'flowchart',
    synonyms: ['stadium', 'pill', 'start', 'stop', 'begin', 'finish'],
    size: { width: 220, height: 90 },
    label: inset(0, 0.12),
    draw: (b) => [{ el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: b.height, rx: Math.min(b.width, b.height) / 2 }],
  },
  'input-output': {
    name: 'Input / output',
    group: 'flowchart',
    synonyms: ['data', 'parallelogram', 'read', 'write', 'io'],
    label: inset(0, 0.2),
    draw: (b) => {
      const skew = Math.min(b.width * 0.2, b.height * 0.4);
      return [
        {
          el: 'path',
          ink: s,
          d: closed([
            [b.x + skew, b.y],
            [b.x + b.width, b.y],
            [b.x + b.width - skew, b.y + b.height],
            [b.x, b.y + b.height],
          ]),
        },
      ];
    },
  },
  'predefined-process': {
    name: 'Predefined process',
    group: 'flowchart',
    synonyms: ['subroutine', 'function', 'call', 'subprocess'],
    label: inset(0, 0.12),
    draw: (b) => {
      const side = Math.min(b.width * 0.1, 16);
      return [
        { el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: b.height },
        { el: 'path', ink: l, d: `M${b.x + side} ${b.y}V${b.y + b.height}M${b.x + b.width - side} ${b.y}V${b.y + b.height}` },
      ];
    },
  },
  document: {
    name: 'Document',
    group: 'flowchart',
    synonyms: ['file', 'report', 'page'],
    label: inset(0, 0, 0.18, 0),
    draw: mock([4, 8, 76, 49], [{ el: 'path', ink: s, d: 'M4 8H76V42C64 35 54 35 40 42S16 49 4 42Z' }]),
  },
  'multi-document': {
    name: 'Multi-document',
    group: 'flowchart',
    synonyms: ['documents', 'files', 'reports', 'pages'],
    label: { top: 0.18, right: 0.16, bottom: 0.2, left: 0 },
    draw: mock(
      [4, 4, 76, 50],
      [
        { el: 'rect', ink: s, x: 12, y: 4, width: 64, height: 34 },
        { el: 'rect', ink: s, x: 8, y: 8, width: 64, height: 34 },
        { el: 'path', ink: s, d: 'M4 12H68V44C58 38 49 38 37 44S14 50 4 44Z' },
      ],
    ),
  },
  'manual-input': {
    name: 'Manual input',
    group: 'flowchart',
    synonyms: ['keyboard', 'form', 'entry', 'type in'],
    label: inset(0.3, 0, 0, 0),
    draw: (b) =>
      [{
        el: 'path',
        ink: s,
        d: closed([
          [b.x, b.y + b.height * 0.3],
          [b.x + b.width, b.y],
          [b.x + b.width, b.y + b.height],
          [b.x, b.y + b.height],
        ]),
      }],
  },
  delay: {
    name: 'Delay',
    group: 'flowchart',
    synonyms: ['wait', 'pause', 'sleep', 'timer'],
    label: inset(0, 0.2, 0, 0),
    draw: (b) => {
      const rx = Math.min(b.height / 2, b.width / 2);
      const right = b.x + b.width - rx;
      return [{ el: 'path', ink: s, d: `M${b.x} ${b.y}H${right}A${rx} ${b.height / 2} 0 0 1 ${right} ${b.y + b.height}H${b.x}Z` }];
    },
  },
  preparation: {
    name: 'Preparation',
    group: 'flowchart',
    synonyms: ['hexagon', 'setup', 'init', 'initialise'],
    label: inset(0, 0.18),
    draw: (b) => {
      const cut = Math.min(b.width * 0.18, b.height * 0.5);
      const cy = b.y + b.height / 2;
      return [
        {
          el: 'path',
          ink: s,
          d: closed([
            [b.x + cut, b.y],
            [b.x + b.width - cut, b.y],
            [b.x + b.width, cy],
            [b.x + b.width - cut, b.y + b.height],
            [b.x + cut, b.y + b.height],
            [b.x, cy],
          ]),
        },
      ];
    },
  },
  'loop-limit': {
    name: 'Loop limit',
    group: 'flowchart',
    synonyms: ['loop', 'repeat', 'for', 'while', 'iterate'],
    label: inset(0.15, 0.04),
    draw: (b) => {
      const cut = Math.min(b.width * 0.16, b.height * 0.3);
      return [
        {
          el: 'path',
          ink: s,
          d: closed([
            [b.x + cut, b.y],
            [b.x + b.width - cut, b.y],
            [b.x + b.width, b.y + cut],
            [b.x + b.width, b.y + b.height],
            [b.x, b.y + b.height],
            [b.x, b.y + cut],
          ]),
        },
      ];
    },
  },
  'off-page': {
    name: 'Off-page reference',
    group: 'flowchart',
    synonyms: ['off-page connector', 'continue', 'next page', 'pentagon', 'link'],
    size: { width: 110, height: 130 },
    label: { top: 0, right: 0, bottom: 0.38, left: 0, tight: true },
    draw: (b) => {
      const shoulder = b.y + b.height * 0.63;
      return [
        {
          el: 'path',
          ink: s,
          d: closed([
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x + b.width, shoulder],
            [b.x + b.width / 2, b.y + b.height],
            [b.x, shoulder],
          ]),
        },
      ];
    },
  },
  'circle-connector': {
    name: 'On-page reference',
    group: 'flowchart',
    synonyms: ['connector', 'circle', 'junction', 'on-page', 'jump', 'dot'],
    size: { width: 80, height: 80 },
    label: { ...inset(0.15), tight: true },
    draw: mock([23, 11, 57, 45], [{ el: 'circle', ink: s, cx: 40, cy: 28, r: 17 }], 'contain'),
  },

  // Architecture
  database: {
    name: 'Database',
    group: 'architecture',
    synonyms: ['db', 'cylinder', 'sql', 'postgres', 'table', 'store'],
    size: { width: 160, height: 150 },
    label: { top: 0.3, right: 0.04, bottom: 0.06, left: 0.04 },
    draw: (b) => {
      const ry = clamp(b.height * 0.11, 6, 20);
      const rx = b.width / 2;
      const right = b.x + b.width;
      const top = b.y + ry;
      const bottom = b.y + b.height - ry;
      return [
        { el: 'path', ink: s, d: `M${b.x} ${top}V${bottom}A${rx} ${ry} 0 0 0 ${right} ${bottom}V${top}` },
        { el: 'ellipse', ink: s, cx: b.x + rx, cy: top, rx, ry },
        { el: 'path', ink: l, d: `M${b.x} ${top + ry * 1.25}A${rx} ${ry} 0 0 0 ${right} ${top + ry * 1.25}` },
      ];
    },
  },
  queue: {
    name: 'Queue / stream',
    group: 'architecture',
    synonyms: ['stream', 'pipe', 'kafka', 'topic', 'bus', 'events', 'messages'],
    size: { width: 240, height: 100 },
    label: { top: 0.08, right: 0.16, bottom: 0.08, left: 0.06 },
    draw: (b) => {
      const rx = clamp(b.width * 0.08, 6, 22);
      const ry = b.height / 2;
      const left = b.x + rx;
      const right = b.x + b.width - rx;
      const bottom = b.y + b.height;
      return [
        { el: 'path', ink: s, d: `M${left} ${b.y}H${right}A${rx} ${ry} 0 0 1 ${right} ${bottom}H${left}A${rx} ${ry} 0 0 1 ${left} ${b.y}Z` },
        { el: 'ellipse', ink: s, cx: right, cy: b.y + ry, rx, ry },
        {
          el: 'path',
          ink: l,
          opacity: 0.55,
          iconOnly: true,
          d: [0.27, 0.4, 0.53].map((at) => `M${b.x + b.width * at} ${b.y + b.height * 0.19}V${b.y + b.height * 0.81}`).join(''),
        },
      ];
    },
  },
  storage: {
    name: 'Storage / disk',
    group: 'architecture',
    synonyms: ['disk', 'data', 'volume', 'drive', 's3', 'bucket', 'blob'],
    size: { width: 220, height: 100 },
    label: { top: 0, right: 0.18, bottom: 0.3, left: 0.04 },
    draw: mock(
      [6, 14, 74, 42],
      [
        { el: 'rect', ink: s, x: 6, y: 14, width: 68, height: 28, rx: 6 },
        { el: 'path', ink: l, d: 'M14 34H44' },
        { el: 'circle', ink: k, cx: 64, cy: 28, r: 3 },
      ],
    ),
  },
  cloud: {
    name: 'Cloud',
    group: 'architecture',
    synonyms: ['internet', 'aws', 'gcp', 'azure', 'saas', 'web'],
    size: { width: 220, height: 140 },
    label: { top: 0.32, right: 0.12, bottom: 0.08, left: 0.12 },
    draw: mock([9.4, 9, 75.05, 46.1], [{ el: 'path', ink: s, d: 'M22 46A11 11 0 0 1 19 24A15 15 0 0 1 46 15A13 13 0 0 1 66 26A10 10 0 0 1 64 46Z' }]),
  },
  server: {
    name: 'Server',
    group: 'architecture',
    synonyms: ['host', 'machine', 'rack', 'backend', 'vm', 'node'],
    size: { width: 110, height: 150 },
    label: { top: 0.68, right: 0.04, bottom: 0.02, left: 0.04, tight: true },
    draw: mock(
      [22, 4, 58, 52],
      [
        { el: 'rect', ink: s, x: 22, y: 4, width: 36, height: 48, rx: 3 },
        { el: 'path', ink: l, d: 'M22 20H58M22 36H58' },
        { el: 'circle', ink: k, cx: 50, cy: 12, r: 2 },
        { el: 'circle', ink: k, cx: 50, cy: 28, r: 2 },
        { el: 'path', ink: l, d: 'M28 12H40M28 28H40' },
        { el: 'circle', ink: k, cx: 50, cy: 44, r: 2, iconOnly: true },
        { el: 'path', ink: l, d: 'M28 44H40', iconOnly: true },
      ],
    ),
  },
  browser: {
    name: 'Client / browser',
    group: 'architecture',
    synonyms: ['client', 'web app', 'frontend', 'window', 'page', 'ui'],
    size: { width: 240, height: 160 },
    label: { top: 0.23, right: 0, bottom: 0, left: 0 },
    draw: mock(
      [4, 6, 76, 50],
      [
        { el: 'rect', ink: s, x: 4, y: 6, width: 72, height: 44, rx: 4 },
        { el: 'path', ink: l, d: 'M4 16H76' },
        { el: 'circle', ink: k, cx: 10, cy: 11, r: 1.6 },
        { el: 'circle', ink: k, cx: 15, cy: 11, r: 1.6 },
        { el: 'circle', ink: k, cx: 20, cy: 11, r: 1.6 },
      ],
    ),
  },
  mobile: {
    name: 'Mobile device',
    group: 'architecture',
    synonyms: ['phone', 'ios', 'android', 'app', 'tablet'],
    size: { width: 90, height: 160 },
    label: { top: 0.14, right: 0.04, bottom: 0.16, left: 0.04, tight: true },
    draw: mock(
      [27, 3, 53, 53],
      [
        { el: 'rect', ink: s, x: 27, y: 3, width: 26, height: 50, rx: 5 },
        { el: 'path', ink: l, d: 'M36 8H44' },
        { el: 'circle', ink: l, cx: 40, cy: 47, r: 2.2 },
      ],
    ),
  },
  user: {
    name: 'User',
    group: 'architecture',
    synonyms: ['person', 'people', 'customer', 'human', 'account'],
    size: { width: 110, height: 140 },
    label: underFigure,
    draw: mock(
      [22, 8, 58, 52],
      [
        { el: 'circle', ink: s, cx: 40, cy: 17, r: 9 },
        { el: 'path', ink: s, d: 'M22 52C22 37 58 37 58 52Z' },
      ],
      'contain',
      aboveText,
    ),
  },
  service: {
    name: 'Service',
    group: 'architecture',
    synonyms: ['hexagon', 'microservice', 'api', 'lambda', 'function'],
    size: { width: 150, height: 140 },
    label: inset(0.24, 0.04),
    draw: mock([10, 3, 70, 53], [{ el: 'polygon', ink: s, points: '40,3 70,15.5 70,40.5 40,53 10,40.5 10,15.5' }]),
  },
  'external-system': {
    name: 'External system',
    group: 'architecture',
    synonyms: ['third party', 'vendor', 'box', 'cube', '3d', 'partner'],
    label: { top: 0.18, right: 0.12, bottom: 0, left: 0 },
    draw: mock(
      [4, 6, 74, 50],
      [
        { el: 'path', ink: s, d: 'M4 14L12 6H74V42L66 50' },
        { el: 'rect', ink: s, x: 4, y: 14, width: 62, height: 36 },
        { el: 'path', ink: l, d: 'M66 14L74 6' },
      ],
    ),
  },
  'load-balancer': {
    name: 'Load balancer',
    group: 'architecture',
    synonyms: ['lb', 'proxy', 'router', 'gateway', 'nginx', 'ingress'],
    size: { width: 110, height: 140 },
    label: underFigure,
    draw: mock(
      [17, 5, 63, 51],
      [
        { el: 'circle', ink: s, cx: 40, cy: 28, r: 23 },
        { el: 'path', ink: l, d: 'M22 28H36M36 28L54 17M36 28H56M36 28L54 39' },
        { el: 'path', ink: l, d: 'M50 14L55 16.5L52 21M52 25L57 28L52 31M52 35L55 39.5L50 42' },
      ],
      'contain',
      aboveText,
    ),
  },
  cache: {
    name: 'Cache',
    group: 'architecture',
    synonyms: ['redis', 'memcached', 'memory', 'fast', 'cdn'],
    size: { width: 200, height: 110 },
    label: { top: 0, right: 0, bottom: 0, left: 0.26 },
    draw: (b) => {
      const glyph = Math.min(b.height * 0.6, b.width * 0.2);
      return [
        { el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: b.height, rx: Math.min(b.width, b.height) * 0.2 },
        ...fitParts([{ el: 'path', ink: k, d: 'M44 12L32 30H40L36 44L50 25H42Z' }], [32, 12, 50, 44], 'contain', {
          x: b.x + b.width * 0.13 - glyph / 2,
          y: b.y + (b.height - glyph) / 2,
          width: glyph,
          height: glyph,
        }),
      ];
    },
  },
  lock: {
    name: 'Lock / security',
    group: 'architecture',
    synonyms: ['security', 'auth', 'secret', 'key', 'vault', 'padlock', 'iam'],
    size: { width: 100, height: 130 },
    label: underFigure,
    draw: mock(
      [24, 9, 56, 50],
      [
        { el: 'path', ink: l, d: 'M31 24V18A9 9 0 0 1 49 18V24' },
        { el: 'rect', ink: s, x: 24, y: 24, width: 32, height: 26, rx: 4 },
        { el: 'circle', ink: k, cx: 40, cy: 35, r: 3 },
        { el: 'path', ink: l, d: 'M40 37V43' },
      ],
      'contain',
      aboveText,
    ),
  },
  container: {
    name: 'Container / group',
    group: 'architecture',
    synonyms: ['group', 'boundary', 'vpc', 'region', 'cluster', 'frame', 'docker', 'pod'],
    size: { width: 360, height: 240 },
    label: { top: 0.02, right: 0.02, bottom: 0, left: 0.02, atTop: true },
    draw: (b) => {
      const tab = { width: Math.min(b.width * 0.38, 120), height: Math.min(12, b.height * 0.2) };
      const top = b.y + tab.height * 0.8;
      return [
        { el: 'rect', ink: s, dashed: true, x: b.x, y: top, width: b.width, height: b.y + b.height - top, rx: Math.min(8, b.height / 8) },
        { el: 'rect', ink: k, opacity: 0.85, x: b.x, y: b.y, width: tab.width, height: tab.height, rx: 2 },
      ];
    },
  },
  note: {
    name: 'Note',
    group: 'architecture',
    synonyms: ['comment', 'memo', 'folded corner', 'annotation'],
    size: { width: 200, height: 140 },
    label: { top: 0.08, right: 0.08, bottom: 0, left: 0 },
    draw: (b) => {
      const fold = Math.min(b.width, b.height) * 0.2;
      const right = b.x + b.width;
      return [
        {
          el: 'path',
          ink: s,
          d: closed([
            [b.x, b.y],
            [right - fold, b.y],
            [right, b.y + fold],
            [right, b.y + b.height],
            [b.x, b.y + b.height],
          ]),
        },
        { el: 'path', ink: l, d: `M${right - fold} ${b.y}V${b.y + fold}H${right}` },
      ];
    },
  },

  // UML
  class: {
    name: 'Class',
    group: 'uml',
    synonyms: ['object', 'entity', 'model', 'type', 'struct'],
    size: { width: 200, height: 180 },
    label: { top: 0, right: 0, bottom: 0.76, left: 0, tight: true },
    draw: mock(
      [12, 3, 68, 53],
      [
        { el: 'rect', ink: s, x: 12, y: 3, width: 56, height: 50 },
        { el: 'path', ink: l, d: 'M12 15H68M12 34H68' },
        { el: 'path', ink: l, opacity: 0.7, iconOnly: true, d: 'M30 9H50' },
        { el: 'path', ink: l, opacity: 0.45, iconOnly: true, d: 'M17 21H44M17 27H38M17 40H50M17 46H42' },
      ],
    ),
  },
  component: {
    name: 'Component',
    group: 'uml',
    synonyms: ['module', 'package', 'library', 'part'],
    size: { width: 220, height: 130 },
    label: { top: 0, right: 0, bottom: 0, left: 0.2 },
    draw: mock(
      [11, 8, 74, 48],
      [
        { el: 'rect', ink: s, x: 18, y: 8, width: 56, height: 40 },
        { el: 'rect', ink: s, x: 11, y: 15, width: 14, height: 8 },
        { el: 'rect', ink: s, x: 11, y: 32, width: 14, height: 8 },
      ],
    ),
  },
  package: {
    name: 'Package',
    group: 'uml',
    synonyms: ['folder', 'namespace', 'module'],
    size: { width: 220, height: 150 },
    label: { top: 0.18, right: 0, bottom: 0, left: 0 },
    draw: mock(
      [6, 6, 74, 50],
      [
        { el: 'path', ink: s, d: 'M6 6H32V14H6Z' },
        { el: 'rect', ink: s, x: 6, y: 14, width: 68, height: 36 },
      ],
    ),
  },
  interface: {
    name: 'Interface',
    group: 'uml',
    synonyms: ['lollipop', 'protocol', 'contract', 'port', 'provided'],
    size: { width: 140, height: 90 },
    label: underFigure,
    draw: mock(
      [8, 17, 64, 39],
      [
        { el: 'path', ink: l, d: 'M8 28H42' },
        { el: 'circle', ink: s, cx: 53, cy: 28, r: 11 },
      ],
      'contain',
      aboveText,
    ),
  },
  actor: {
    name: 'Actor',
    group: 'uml',
    synonyms: ['stick figure', 'person', 'role', 'user'],
    size: { width: 100, height: 150 },
    label: underFigure,
    draw: mock(
      [28, 4, 52, 51],
      [
        { el: 'circle', ink: s, cx: 40, cy: 10, r: 6 },
        { el: 'path', ink: l, d: 'M40 16V34M28 23H52M40 34L30 51M40 34L50 51' },
      ],
      'contain',
      aboveText,
    ),
  },
  'use-case': {
    name: 'Use case',
    group: 'uml',
    synonyms: ['scenario', 'story', 'feature', 'oval'],
    size: { width: 220, height: 110 },
    ...OVAL,
  },
  lifeline: {
    name: 'Lifeline',
    group: 'uml',
    synonyms: ['sequence', 'participant', 'timeline', 'object'],
    size: { width: 140, height: 280 },
    label: { top: 0, right: 0, bottom: 0.78, left: 0, tight: true },
    draw: (b) => {
      const head = Math.min(b.height * 0.22, 56);
      const cx = b.x + b.width / 2;
      const bar = Math.min(14, b.width * 0.12);
      return [
        { el: 'rect', ink: s, x: b.x, y: b.y, width: b.width, height: head, rx: 2 },
        { el: 'path', ink: l, dashed: true, d: `M${cx} ${b.y + head}V${b.y + b.height}` },
        { el: 'rect', ink: s, x: cx - bar / 2, y: b.y + head + (b.height - head) * 0.22, width: bar, height: (b.height - head) * 0.5 },
      ];
    },
  },
  state: {
    name: 'State',
    group: 'uml',
    synonyms: ['status', 'mode', 'step', 'rounded'],
    size: { width: 220, height: 130 },
    label: { top: 0, right: 0, bottom: 0.66, left: 0, tight: true },
    draw: mock(
      [6, 8, 74, 48],
      [
        { el: 'rect', ink: s, x: 6, y: 8, width: 68, height: 40, rx: 12 },
        { el: 'path', ink: l, d: 'M6 21H74' },
      ],
    ),
  },
  start: {
    name: 'Start',
    group: 'uml',
    synonyms: ['initial', 'begin', 'entry', 'dot'],
    size: { width: 64, height: 84 },
    label: underFigure,
    draw: mock([30, 18, 50, 38], [{ el: 'circle', ink: k, cx: 40, cy: 28, r: 10 }], 'contain', aboveText),
  },
  end: {
    name: 'End',
    group: 'uml',
    synonyms: ['final', 'finish', 'stop', 'exit', 'bullseye'],
    size: { width: 64, height: 84 },
    label: underFigure,
    draw: mock(
      [28, 16, 52, 40],
      [
        { el: 'circle', ink: s, cx: 40, cy: 28, r: 12 },
        { el: 'circle', ink: k, cx: 40, cy: 28, r: 7 },
      ],
      'contain',
      aboveText,
    ),
  },
  choice: {
    name: 'Choice',
    group: 'uml',
    synonyms: ['merge', 'branch', 'guard', 'diamond'],
    size: { width: 60, height: 60 },
    ...RHOMBUS,
  },
  'fork-join': {
    name: 'Fork / join',
    group: 'uml',
    synonyms: ['fork', 'join', 'bar', 'parallel', 'sync', 'split'],
    size: { width: 220, height: 64 },
    label: underFigure,
    draw: (box) => {
      const b = aboveText(box);
      const thick = Math.min(b.height, 12);
      return [{ el: 'rect', ink: k, x: b.x, y: b.y + (b.height - thick) / 2, width: b.width, height: thick, rx: Math.min(2, thick / 4) }];
    },
  },
};

/** Every shape, by its kind. */
export const SHAPES: Record<ShapeType, ShapeKind> = Object.fromEntries(
  SHAPE_TYPES.map((type) => [type, { size: DEFAULT_SHAPE_SIZE, ...KINDS[type] }]),
) as Record<ShapeType, ShapeKind>;
