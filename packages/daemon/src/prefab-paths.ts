// A non-maker's own paths in a shared crew worktree: folders (ending in `/`) and files, relative to the repo root. Each
// is normalised before any check, and two overlap when, compared without case, one is the other or a folder that holds
// it. Case is ignored on every system, so a prefab made on a case-sensitive one is safe on one that isn't.

/** The longest path, and the most paths one member writes to. */
const MAX_WRITES_PATH_LENGTH = 200;
export const MAX_WRITES_PATHS = 20;

// Control, format (bidi, zero-width), private-use and unassigned characters, and the line and paragraph separators:
// nothing that could hide or reorder what a path, a label or a line shows.
export const HIDDEN = /[\p{C}\u2028\u2029]/u;

/**
 * `path` normalised: Unicode in NFC form, `./` and repeated `/` removed. Its reason instead when it is no path a member
 * may own: empty, absolute, with a `..`, a backslash, or a control character.
 */
export function normaliseWritesPath(path: string): { path: string } | { error: string } {
  const text = path.normalize('NFC').trim();
  if (text === '') return { error: 'a path is not empty' };
  if (HIDDEN.test(text)) return { error: `${JSON.stringify(text)} has a control or format character` };
  if (text.includes('\\')) return { error: `${text} uses /, not \\, between its parts` };
  if (text.startsWith('/') || /^[a-z]:/i.test(text) || text.startsWith('~')) return { error: `${text} is relative to the repo's root, not absolute` };
  const folder = text.endsWith('/');
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return { error: `${text} stays inside the repo: no ..` };
  if (parts.length === 0) return { error: `${text} names no folder or file: the repo's root is everyone's` };
  const joined = parts.join('/');
  if (joined.length > MAX_WRITES_PATH_LENGTH) return { error: `a path is at most ${MAX_WRITES_PATH_LENGTH} characters` };
  return { path: folder ? `${joined}/` : joined };
}

/** Whether two normalised paths overlap: without case, one is the other, or a folder that holds it. */
export function writesPathsOverlap(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const holds = (folder: string, path: string) => folder.endsWith('/') && path.startsWith(folder);
  return x === y || holds(x, y) || holds(y, x) || `${x}/` === y || `${y}/` === x;
}
