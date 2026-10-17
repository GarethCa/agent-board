import { SHAPE_TYPES, type ShapeType } from '@agent-board/daemon/protocol';
import { SHAPES } from './catalogue';

/** Where a query was found: in a shape's name or one of its other words, and which letters of it. */
export interface ShapeMatch {
  in: 'name' | 'synonym';
  text: string;
  from: number;
  to: number;
}

export interface ShapeResult {
  shape: ShapeType;
  /** Missing when every shape is listed, or the query's letters were only found in order. */
  match?: ShapeMatch;
}

/** Where `query` starts a word of `text` (or the text itself), or -1. */
function wordStart(text: string, query: string): number {
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return at;
  }
  return -1;
}

/** Whether `query`'s letters come in order in `text`, from its first letter. */
function inOrder(text: string, query: string): boolean {
  if (text[0] !== query[0]) return false;
  let at = 0;
  for (const letter of query) {
    at = text.indexOf(letter, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/**
 * The shapes `query` finds, best first (the picker's search and the `/` palette): the start of a name, then the start of
 * another word for it ("db", "data"), then a name's letters anywhere, then in order from its first. Another word
 * matches only from the start of one of its words, so "da" doesn't find "lambda". Ties keep the picker's order. An empty query finds every shape.
 */
export function searchShapes(query: string): ShapeResult[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return SHAPE_TYPES.map((shape) => ({ shape }));
  const found: { shape: ShapeType; rank: number; match?: ShapeMatch }[] = [];
  SHAPE_TYPES.forEach((shape) => {
    const { name, synonyms } = SHAPES[shape];
    const lowerName = name.toLowerCase();
    const at = (text: string, from: number, where: ShapeMatch['in']): ShapeMatch => ({ in: where, text, from, to: from + wanted.length });
    const tiers: (() => { rank: number; match?: ShapeMatch } | undefined)[] = [
      () => (lowerName.startsWith(wanted) ? { rank: 0, match: at(name, 0, 'name') } : undefined),
      () => {
        const from = wordStart(lowerName, wanted);
        return from === -1 ? undefined : { rank: 1, match: at(name, from, 'name') };
      },
      () => {
        for (const synonym of synonyms) {
          const from = wordStart(synonym, wanted);
          if (from !== -1) return { rank: 2, match: at(synonym, from, 'synonym') };
        }
        return undefined;
      },
      () => {
        const from = lowerName.indexOf(wanted);
        return from === -1 ? undefined : { rank: 3, match: at(name, from, 'name') };
      },
      () => (inOrder(lowerName, wanted) ? { rank: 4 } : undefined),
    ];
    for (const tier of tiers) {
      const hit = tier();
      if (hit !== undefined) return void found.push({ shape, ...hit });
    }
  });
  return found.sort((a, b) => a.rank - b.rank).map(({ shape, match }) => (match === undefined ? { shape } : { shape, match }));
}
