// Text cut short for a line, a label or a note: by the characters a reader sees (graphemes), so an emoji is never split
// into half a surrogate pair, which JSON prints as `\ud83e`.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `text` as it is if it has at most `length` characters, else its first ones and an ellipsis, `length` in all. */
export function cutText(text: string, length: number): string {
  // A string has at least as many UTF-16 units as characters: one that short fits without segmenting it.
  if (text.length <= length) return text;
  const characters = Array.from(graphemes.segment(text), (segment) => segment.segment);
  if (characters.length <= length) return text;
  return `${characters.slice(0, Math.max(0, length - 1)).join('').trimEnd()}…`;
}
