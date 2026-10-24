// Writing the user's text to an agent's file: a document's save, and a plan's approved version. Only a real file inside
// the agent's worktree is written, never through a link, and whole, so a reader never sees half of it.
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/** The real path of `path`, links resolved; `path` itself if it can't be resolved. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `path` is inside `folder`. */
export function isInside(folder: string, path: string): boolean {
  const inside = relative(folder, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * Why the file at `path`, a real path when it was shown, can't be written now: gone, or made a link since. Undefined
 * when it can.
 */
export function whyNotWritable(path: string): string | undefined {
  let link: boolean;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    return 'the file is gone: it was moved or deleted since it was shown';
  }
  if (link || realPath(path) !== path) return "the file has been made a link since it was shown, so it isn't written: show it again";
  return undefined;
}

/**
 * Writes `text` to the file at `path` whole, through a file beside it renamed over it, so a reader never sees half of
 * it; it keeps the file's mode.
 */
export function writeWhole(path: string, text: string, mode: number): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text);
    chmodSync(temporary, mode & 0o7777);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
