// A line diff of two texts, for an agent to read what the user changed in one of its documents: `- ` a line taken
// out, `+ ` a line put in, `  ` a line of context, and `…` between hunks. Pure, with no dependency.

/** How many unchanged lines are kept either side of a change. */
const CONTEXT = 1;

/** Past this many line pairs in the changed middle, it is shown as one block taken out and put in, not matched line by line. */
const MAX_PAIRS = 4_000_000;

type Line = { op: ' ' | '-' | '+'; text: string };

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** The longest common subsequence's edit script between `a` and `b`. */
function editScript(a: readonly string[], b: readonly string[]): Line[] {
  if (a.length * b.length > MAX_PAIRS) return [...a.map((text): Line => ({ op: '-', text })), ...b.map((text): Line => ({ op: '+', text }))];
  // lengths[i][j]: the LCS of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const script: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      script.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) script.push({ op: '-', text: a[i++]! });
    else script.push({ op: '+', text: b[j++]! });
  }
  while (i < a.length) script.push({ op: '-', text: a[i++]! });
  while (j < b.length) script.push({ op: '+', text: b[j++]! });
  return script;
}

/** The changes from `before` to `after`, line by line, with a line of context; empty when the lines are the same. */
export function lineDiff(before: string, after: string): string {
  const a = linesOf(before);
  const b = linesOf(after);
  // Only the middle that differs is matched: the lines both start and end with are context.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const script: Line[] = [
    ...a.slice(0, start).map((text): Line => ({ op: ' ', text })),
    ...editScript(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map((text): Line => ({ op: ' ', text })),
  ];
  const near = script.map((_, index) => script.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((line) => line.op !== ' '));
  const out: string[] = [];
  script.forEach((line, index) => {
    if (!near[index]) return;
    if (out.length > 0 && !near[index - 1]) out.push('…');
    out.push(`${line.op} ${line.text}`);
  });
  return out.join('\n');
}

/** The longest diff an agent is told: past it, it is told to read the file. */
const MAX_TOLD_DIFF = 6_000;

/** `diff` as an agent is told it: cut past `MAX_TOLD_DIFF`, saying to read the file for the rest. */
export const toldDiff = (diff: string): string => (diff.length <= MAX_TOLD_DIFF ? diff : `${diff.slice(0, MAX_TOLD_DIFF)}\n… (more: read the file)`);
