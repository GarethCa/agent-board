import type { Heading, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { isTitleHeading } from './doc-view';
import { DECISION_ID, markForReading, SEVERITIES, type Outline, type OutlineFinding, type Severity } from './remark-findings';

/** A reader's pace, for the time a document takes and the time left in it. */
const WORDS_PER_MINUTE = 230;
/** The narrowest reading view that shows its rail unless told: below it the page reads as one column. */
const RAIL_MIN_WIDTH = 760;

export { DECISION_ID };

export type VerdictTone = 'ok' | 'waiting' | 'failed' | 'neutral';

/** A document's `VERDICT: …` first line, as a chip. */
export interface Verdict {
  /** As written, such as `changes-requested`. */
  text: string;
  /** As a chip says it: `Changes requested`. */
  label: string;
  tone: VerdictTone;
}

/** The decision card: the verdict, then the part written for the reader, both lifted from the document as written. */
export interface Decision {
  verdict?: Verdict;
  /** Markdown, each item's words before its first colon (or question mark) set bold. */
  body?: string;
  /** The section the body came from, for a jump to it. */
  from?: { id: string; title: string };
}

/** A Markdown document made ready to read. */
export interface Reading {
  /** What the column renders: the text without its verdict line, or a first heading that is the title. */
  body: string;
  decision: Decision | undefined;
  outline: Outline;
  words: number;
}

const parse = (text: string): Root => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const VERDICT = /^\s*VERDICT:\s*(\S.*?)\s*$/i;
/** The sections a decision card's body may come from, in the order they are looked for. */
const FOR_READER = /^for\s+(?!example\b|instance\b|each\b|every\b|all\b|more\b|now\b|later\b|reference\b)\S/i;
const SUMMARY = /^(?:tl;?\s?dr|summary|decision)\b/i;

const FAILED = /^(?:reject|fail|block)/;
const WAITING = /^(?:change|request|revise|rework)/;
const OK = /^(?:approve|accept|pass|lgtm|ready|ok|ship|merge)/;

/** `changes-requested` as a chip says it, and the state colour its leading word gives it ("not blocked" is neutral). */
export function verdictOf(text: string): Verdict {
  const words = text.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const lead = words.split(' ')[0] ?? '';
  const tone: VerdictTone = FAILED.test(lead) ? 'failed' : WAITING.test(lead) ? 'waiting' : OK.test(lead) ? 'ok' : 'neutral';
  return { text, label: words.charAt(0).toUpperCase() + words.slice(1), tone };
}

const LEAD = /^(\s{0,3}(?:\d+[.)]|[-*+])\s+)(?!\*\*)([^:?*`\n[\]]{2,40}?[:?])(?=\s)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Sets bold each list item's words before its first colon or question mark, so "Must change:" reads first; not in code. */
export function boldLeads(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) {
        fence = fence === undefined ? marker : undefined;
        return line;
      }
      return fence === undefined ? line.replace(LEAD, '$1**$2**') : line;
    })
    .join('\n');
}

const idOf = (heading: Heading): string => String(heading.data?.hProperties?.id ?? '');

/** The text of `nodes[from…to)`, as written in `text`. */
function slice(text: string, nodes: RootContent[], from: number, to: number): string {
  const first = nodes[from]?.position?.start.offset;
  const last = nodes[to - 1]?.position?.end.offset;
  return first === undefined || last === undefined || to <= from ? '' : text.slice(first, last).trim();
}

/**
 * The section the card's body comes from: the first "For …" section, else the first TL;DR, Summary or Decision. Never a
 * first-level one: under a document's top heading, that section would be the whole document.
 */
function decisionSection(body: string, tree: Root): { id: string; title: string; text: string } | undefined {
  const nodes = tree.children;
  const headings = nodes.flatMap((node, index) => (node.type === 'heading' && node.depth > 1 ? [{ node, index }] : []));
  const found = headings.find(({ node }) => FOR_READER.test(toString(node))) ?? headings.find(({ node }) => SUMMARY.test(toString(node)));
  if (found === undefined) return undefined;
  const end = nodes.findIndex((node, index) => index > found.index && node.type === 'heading' && node.depth <= found.node.depth);
  const text = slice(body, nodes, found.index + 1, end === -1 ? nodes.length : end);
  return text === '' ? undefined : { id: idOf(found.node), title: toString(found.node), text };
}

/** How many words a Markdown text has, near enough: its runs of letters or digits. */
export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/**
 * A Markdown document made ready to read: its `VERDICT:` first line comes off as the card's chip, a first heading that
 * is `title` comes off (the head says it), and the card's body is the first "For …" section, else the first TL;DR,
 * Summary or Decision. With neither a verdict nor such a section there is no card. Nothing is summarised: it is all as written.
 */
export function readingOf(text: string, title?: string): Reading {
  const lines = text.split('\n');
  let at = lines.findIndex((line) => line.trim() !== '');
  const verdictLine = at === -1 ? null : VERDICT.exec(lines[at]!);
  if (verdictLine) {
    lines.splice(at, 1);
    at = lines.findIndex((line) => line.trim() !== '');
  }
  if (at !== -1 && isTitleHeading(lines[at]!, title)) lines.splice(at, 1);
  const body = lines.join('\n').replace(/^\s*\n/, '');

  const tree = parse(body);
  const outline = markForReading(tree, false);
  const section = decisionSection(body, tree);
  const verdict = verdictLine ? verdictOf(verdictLine[1]!) : undefined;
  // With neither, there is no card: it would only say again the first paragraph, just below it.
  const decision: Decision | undefined = section
    ? { verdict, body: boldLeads(section.text), from: { id: section.id, title: section.title } }
    : verdict && { verdict };
  return { body, decision, outline, words: wordCount(body) };
}

/** Every finding in an outline, in the document's order. */
export const findingsOf = (outline: Outline): OutlineFinding[] => [...outline.leading, ...outline.sections.flatMap((section) => section.findings)];

/** How many findings of each severity, in severity order, leaving out those with none. */
function severityCounts(findings: readonly OutlineFinding[]): { severity: Severity; count: number }[] {
  return SEVERITIES.map((severity) => ({ severity, count: findings.filter((finding) => finding.severity === severity).length })).filter(({ count }) => count > 0);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** "2 blockers", "1 major", "4 minor": only a blocker is a noun with a plural. */
const severityWord = ({ severity, count }: { severity: Severity; count: number }) => (severity === 'blocker' ? plural(count, 'blocker') : `${count} ${severity}`);

/** "7 findings: 2 blockers, 1 major, 4 minor", for the card; empty with none. */
export const findingsLine = (findings: readonly OutlineFinding[]): string =>
  findings.length === 0 ? '' : `${plural(findings.length, 'finding')}: ${severityCounts(findings).map(severityWord).join(', ')}`;

/** "2 blockers · 1 major · 4 minor", for the rail's foot. */
export const severityLine = (findings: readonly OutlineFinding[]): string => severityCounts(findings).map(severityWord).join(' · ');

/** The minutes it takes to read what is below `fraction` of `words`, at least one. */
export function minutesLeft(words: number, fraction: number): number {
  const left = words * (1 - Math.min(1, Math.max(0, fraction)));
  return Math.max(1, Math.ceil(left / WORDS_PER_MINUTE));
}

/** The head's time: "8 min read" at the top, "5 min left" on the way, "Read to the end" at it. */
export function timeLeft(words: number, fraction: number): string {
  if (fraction < 0.02) return `${minutesLeft(words, 0)} min read`;
  if (fraction > 0.98) return 'Read to the end';
  return `${minutesLeft(words, fraction)} min left`;
}

/** A place in the rail's map: a section or a finding (or the decision card), with how far down the column it starts. */
export interface Mark {
  id: string;
  /** The section it belongs to: itself, for a section. */
  section: string;
  top: number;
}

/** Where the reader is: the mark they are in, its section, and the marks they have scrolled past. */
export interface Spy {
  current: string | undefined;
  section: string | undefined;
  passed: ReadonlySet<string>;
}

/**
 * Scroll-spy: the reader is in the last mark that starts above `scrollTop` (plus `offset`, so a heading just scrolled to
 * counts), or the first. A mark is passed once a later one is current; a section once a later section is; and at the
 * end of the column the current one too.
 */
export function spy(marks: readonly Mark[], scrollTop: number, atEnd: boolean, offset = 60): Spy {
  if (marks.length === 0) return { current: undefined, section: undefined, passed: new Set() };
  let index = 0;
  marks.forEach((mark, at) => {
    if (mark.top - offset <= scrollTop) index = at;
  });
  const current = marks[index]!;
  const sections = [...new Set(marks.map((mark) => mark.section))];
  const sectionAt = sections.indexOf(current.section);
  const passed = new Set<string>();
  marks.forEach((mark, at) => {
    const own = mark.id === mark.section;
    if (own ? sections.indexOf(mark.id) < sectionAt : at < index) passed.add(mark.id);
  });
  if (atEnd) {
    passed.add(current.id);
    passed.add(current.section);
  }
  return { current: current.id, section: current.section, passed };
}

/** Whether the rail shows: as the user set it with ⌘\, else when the view is wide enough. */
export const railShown = (width: number, override: boolean | undefined): boolean => override ?? width >= RAIL_MIN_WIDTH;

/** Where a reader left a document: kept in the renderer, by its path. */
export interface Place {
  top: number;
  /** The findings left open, by id: a finding's id comes from its headline, so a rewrite keeps the others'. */
  open: string[];
}

export const placeKey = (path: string): string => `reading-place:${path}`;

/** A kept place read back, or undefined if it is missing or not one. */
export function placeOf(raw: string | null): Place | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const { top, open } = value as Record<string, unknown>;
    if (typeof top !== 'number' || !Array.isArray(open)) return undefined;
    return { top: Math.max(0, top), open: open.filter((id): id is string => typeof id === 'string') };
  } catch {
    return undefined;
  }
}
