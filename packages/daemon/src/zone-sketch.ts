// A plain drawing of a zone from what the daemon knows: each tile and item as a labelled box where the board keeps it,
// at the size the map gives it, and the edges and connectors between them as straight lines. No terminal, note body
// or picture is drawn: names and short texts only, as `zone map` prints them.
import { CAPTURE_MARGIN, type ZoneMap, type ZoneMapThing } from './protocol.ts';

/** A line between two things of the map, by key: an edge that hands work on, or a connector drawn on the board. */
export interface SketchLine {
  from: string;
  to: string;
  kind: 'edge' | 'connector';
}

const FONT = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
const INK = '#1f2328';
const MUTED = '#59636e';
/** Fills by what a box is: tiles plain, notes in their usual colours. */
const FILLS: Record<string, string> = { tile: '#ffffff', sticky: '#fff1a8', 'agent-note': '#e8f0fe', text: 'none', shape: '#f6f8fa', plan: '#eef6ee', label: 'none' };

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** `text` cut to what fits in `width` px at `size` px type, roughly. */
function fitted(text: string, width: number, size: number): string {
  const most = Math.max(1, Math.floor(width / (size * 0.56)));
  return text.length <= most ? text : `${text.slice(0, Math.max(1, most - 1))}…`;
}

const centre = (thing: ZoneMapThing) => ({ x: thing.x + thing.width / 2, y: thing.y + thing.height / 2 });

/** Where the line from `from`'s centre towards `to` leaves `from`'s box. */
function edgeOf(from: ZoneMapThing, to: { x: number; y: number }) {
  const c = centre(from);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(dx === 0 ? Infinity : from.width / 2 / Math.abs(dx), dy === 0 ? Infinity : from.height / 2 / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function box(thing: ZoneMapThing): string {
  const kind = thing.itemKind ?? 'tile';
  const { x, y } = thing;
  const fill = FILLS[kind] ?? FILLS.shape!;
  const framed = kind !== 'text' && kind !== 'label';
  const lines = [
    `<rect x="${x}" y="${y}" width="${thing.width}" height="${thing.height}" rx="${kind === 'tile' ? 10 : 4}" fill="${fill}"${framed ? ` stroke="${kind === 'tile' ? INK : MUTED}" stroke-width="${kind === 'tile' ? 2 : 1}"` : ' stroke="#afb8c1" stroke-dasharray="4 4"'}/>`,
    `<text x="${x + 12}" y="${y + 24}" font-size="16" font-weight="${kind === 'tile' ? 600 : 400}" fill="${INK}">${escape(fitted(thing.name, thing.width - 24, 16))}</text>`,
  ];
  const detail = thing.state ?? (thing.itemKind === null ? null : thing.itemKind);
  if (detail !== null && thing.height >= 48) lines.push(`<text x="${x + 12}" y="${y + 44}" font-size="13" fill="${MUTED}">${escape(fitted(detail, thing.width - 24, 13))}</text>`);
  if (kind === 'tile' && thing.height >= 96) {
    lines.push(`<text x="${x + thing.width / 2}" y="${y + thing.height / 2 + 14}" font-size="12" fill="${MUTED}" text-anchor="middle">terminal hidden</text>`);
  }
  return lines.join('');
}

/**
 * The zone, with `CAPTURE_MARGIN` round it, as an SVG `scale` times that size in board px. Its things are where the map
 * has them: from the zone's top-left.
 */
export function zoneSketch({ zone, map, lines, scale }: { zone: { width: number; height: number; name: string }; map: Pick<ZoneMap, 'things'>; lines: readonly SketchLine[]; scale: number }): string {
  const byKey = new Map(map.things.map((thing) => [thing.key, thing]));
  const drawn = lines.flatMap((line) => {
    const from = byKey.get(line.from);
    const to = byKey.get(line.to);
    if (from === undefined || to === undefined || from === to) return [];
    const start = edgeOf(from, centre(to));
    const end = edgeOf(to, centre(from));
    const look = line.kind === 'edge' ? `stroke="${INK}" stroke-width="2" marker-end="url(#arrow)"` : `stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="6 4"`;
    return [`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" ${look}/>`];
  });
  // Big boxes first, so a note on a tile is drawn over it.
  const things = [...map.things].sort((a, b) => b.width * b.height - a.width * a.height);
  const margin = CAPTURE_MARGIN;
  const width = Math.max(1, Math.round((zone.width + 2 * margin) * scale));
  const height = Math.max(1, Math.round((zone.height + 2 * margin) * scale));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-margin} ${-margin} ${zone.width + 2 * margin} ${zone.height + 2 * margin}" font-family="${FONT}">`,
    `<rect x="${-margin}" y="${-margin}" width="${zone.width + 2 * margin}" height="${zone.height + 2 * margin}" fill="#ffffff"/>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs>`,
    `<rect x="1" y="1" width="${zone.width - 2}" height="${zone.height - 2}" rx="12" fill="#fafbfc" stroke="#d0d7de" stroke-width="2"/>`,
    `<text x="16" y="28" font-size="18" font-weight="700" fill="${MUTED}">${escape(fitted(zone.name, zone.width - 32, 18))}</text>`,
    ...things.map(box),
    ...drawn,
    '</svg>',
  ].join('\n');
}
