// A PR tab's diff (BI1): a file's unified diff hunks, as GitHub gives them, line by line. Pure.

/** One line of a file's diff, with its line numbers on the side it is on. */
export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'context'; text: string; old: number; new: number }
  | { kind: 'deletion'; text: string; old: number }
  | { kind: 'addition'; text: string; new: number }
  /** git's "\ No newline at end of file". */
  | { kind: 'note'; text: string };

/** A hunk's header: where it starts on each side. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The lines of a file's unified diff hunks, each numbered on its side. */
export function diffLines(patch: string): DiffLine[] {
  if (patch === '') return [];
  let old = 0;
  let next = 0;
  return patch.split('\n').map((line): DiffLine => {
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      return { kind: 'hunk', text: line };
    }
    const text = line.slice(1);
    if (line.startsWith('+')) return { kind: 'addition', text, new: next++ };
    if (line.startsWith('-')) return { kind: 'deletion', text, old: old++ };
    if (line.startsWith('\\')) return { kind: 'note', text: line };
    return { kind: 'context', text, old: old++, new: next++ };
  });
}
