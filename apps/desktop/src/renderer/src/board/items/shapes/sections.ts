// The sections under a shape's text, as a class has its attributes and methods under its name.
import type { ShapeData, ShapeSection, ShapeType } from '@agent-board/daemon/protocol';
import { SHAPES } from './catalogue';

/** Each section `style`'s kind of shape has under its text, with its text, in the order they are drawn. */
export function sectionTexts(style: ShapeData): { section: ShapeSection; text: string }[] {
  return (SHAPES[style.shape].sections ?? []).map((section) => ({ section, text: style[section] }));
}

/** All a shape says, as one text: its own, then each of its sections that has any, under its name. */
export function shapeWords(style: ShapeData): string {
  const sections = sectionTexts(style).filter(({ text }) => text !== '');
  return [style.text, ...sections.map(({ section, text }) => `${section}:\n${text}`)].filter((text) => text !== '').join('\n');
}

/**
 * The data that changes `style`'s shape to a `shape`. Mono is a class's sections' look, and the text's look on any
 * other kind: going from a kind with sections to one without, or back, it takes the new kind's own.
 */
export function kindChange(style: ShapeData, shape: ShapeType): Partial<ShapeData> {
  const hasSections = SHAPES[shape].sections !== undefined;
  return hasSections === (SHAPES[style.shape].sections !== undefined) ? { shape } : { shape, mono: hasSections };
}

const STEREOTYPE = /^\s*(?:«([^»\n]*)»|<<([^>\n]*)>>)\s*$/;

/**
 * A class name split into its stereotype, a first line of its own such as `«entity»` (or `<<entity>>`), and the rest.
 * Without one, the stereotype is `fallback`, as a box interface's is `«interface»`.
 */
export function stereotyped(text: string, fallback: string | null = null): { stereotype: string | null; name: string } {
  const [first = '', ...rest] = text.split('\n');
  const match = STEREOTYPE.exec(first);
  if (match === null) return { stereotype: fallback, name: text };
  return { stereotype: `«${match[1] ?? match[2]}»`, name: rest.join('\n') };
}
