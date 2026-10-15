import { describe, expect, it } from 'vitest';
import { diffLines } from './pr-diff';

describe("a PR tab's diff", () => {
  it('numbers each line of a hunk on its side, additions and deletions told apart', () => {
    expect(diffLines('@@ -3,3 +3,4 @@ function login() {\n context\n-old\n+new\n+more\n end')).toEqual([
      { kind: 'hunk', text: '@@ -3,3 +3,4 @@ function login() {' },
      { kind: 'context', text: 'context', old: 3, new: 3 },
      { kind: 'deletion', text: 'old', old: 4 },
      { kind: 'addition', text: 'new', new: 4 },
      { kind: 'addition', text: 'more', new: 5 },
      { kind: 'context', text: 'end', old: 5, new: 6 },
    ]);
  });

  it("starts each hunk at its own lines, and keeps git's no-newline note as a note", () => {
    expect(diffLines('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n@@ -10,0 +11 @@\n+c')).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'deletion', text: 'a', old: 1 },
      { kind: 'note', text: '\\ No newline at end of file' },
      { kind: 'addition', text: 'b', new: 1 },
      { kind: 'hunk', text: '@@ -10,0 +11 @@' },
      { kind: 'addition', text: 'c', new: 11 },
    ]);
  });

  it('is nothing for no patch', () => {
    expect(diffLines('')).toEqual([]);
  });
});
