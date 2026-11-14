import type { BlockContent, Blockquote, Emphasis, List, ListItem, Nodes, Paragraph, PhrasingContent, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';

/** How much a review's finding matters, from the tag that starts it: `[blocker]`, `[major]` or `[minor]`. */
export type Severity = 'blocker' | 'major' | 'minor';

export const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor'];

/** A finding: a list item that starts with a severity tag. Its headline is what its summary shows, folded. */
export interface OutlineFinding {
  id: string;
  severity: Severity;
  headline: string;
}

/** A section of a document (second-level, or first-level in a document with none), with the findings in it. `id` is its heading's, for a jump. */
export interface OutlineSection {
  id: string;
  title: string;
  findings: OutlineFinding[];
}

/** A document's map: its sections, and any findings before the first of them. */
export interface Outline {
  sections: OutlineSection[];
  /** Findings above the first section. */
  leading: OutlineFinding[];
}

/** The decision card's id, at the top of the column: no heading or finding is given it. */
export const DECISION_ID = 'read-decision';

const TAG = /^\s*\[(blocker|major|minor)\]\s*/i;

/** A heading's text as an id: lower case, words joined by `-`, and `read-` before it so it never meets the app's own. */
export function slugOf(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return `read-${words === '' ? 'section' : words}`;
}

/** The severity a paragraph's first words tag it with, and the node that holds the tag (the paragraph or its first bold). */
function tagOf(paragraph: Paragraph): { severity: Severity; holder: Paragraph | Extract<PhrasingContent, { type: 'strong' }> } | undefined {
  const first = paragraph.children[0];
  if (first?.type === 'strong') {
    const match = TAG.exec(toString(first));
    if (match && first.children[0]?.type === 'text' && TAG.test(first.children[0].value)) return { severity: match[1]!.toLowerCase() as Severity, holder: first };
  }
  if (first?.type === 'text') {
    const match = TAG.exec(first.value);
    if (match) return { severity: match[1]!.toLowerCase() as Severity, holder: paragraph };
  }
  return undefined;
}

/** Takes the tag off the first text in `holder`, and any space left at its start. */
function stripTag(holder: { children: PhrasingContent[] }): void {
  const text = holder.children[0];
  if (text?.type === 'text') text.value = text.value.replace(TAG, '');
}

const label = (severity: Severity) => severity[0]!.toUpperCase() + severity.slice(1);

/** A severity chip: `<span class="sev" data-sev>`. */
function chip(severity: Severity): Emphasis {
  return { type: 'emphasis', data: { hName: 'span', hProperties: { className: ['sev'], dataSev: severity } }, children: [{ type: 'text', value: label(severity) }] };
}

/** The first sentence of a run of text, and what follows it, or undefined with no sentence end before more text. */
const SENTENCE = /^\s*(.+?[.!?])\s+(\S[\s\S]*)$/;

/**
 * Splits a tagged paragraph into the headline its summary shows and the inline rest: the bold the tag starts; or, when
 * that bold is the tag alone (`**[blocker]** The build breaks. Because…`), the first sentence after it; or the paragraph.
 */
function split(paragraph: Paragraph, holder: Paragraph | Extract<PhrasingContent, { type: 'strong' }>): { headline: PhrasingContent[]; rest: PhrasingContent[] } {
  stripTag(holder);
  if (holder === paragraph) return { headline: paragraph.children, rest: [] };
  let rest = paragraph.children.slice(1);
  if (toString(holder).trim() === '') {
    const first = rest[0];
    const sentence = first?.type === 'text' ? SENTENCE.exec(first.value) : null;
    if (!sentence) return { headline: trimStart(rest), rest: [] };
    return { headline: [{ type: 'text', value: sentence[1]! }], rest: [{ type: 'text', value: sentence[2]! }, ...rest.slice(1)] };
  }
  rest = trimStart(rest);
  return { headline: holder.children, rest };
}

function trimStart(nodes: PhrasingContent[]): PhrasingContent[] {
  const lead = nodes[0];
  if (lead?.type === 'text') lead.value = lead.value.replace(/^\s+/, '');
  return nodes;
}

/**
 * Folds a tagged list item into a `<details class="finding">`: its summary is the chip and the headline (see split), its
 * body the rest as written. Returns the headline, as text.
 */
function fold(item: ListItem, paragraph: Paragraph, severity: Severity, holder: Paragraph | Extract<PhrasingContent, { type: 'strong' }>): string {
  const { headline, rest } = split(paragraph, holder);
  const body: BlockContent[] = [];
  if (rest.some((node) => toString(node).trim() !== '')) body.push({ type: 'paragraph', children: rest });
  body.push(...(item.children.slice(1) as BlockContent[]));
  const summary: Emphasis = { type: 'emphasis', data: { hName: 'summary' }, children: [chip(severity), { type: 'text', value: ' ' }, ...headline] };
  const content: Blockquote = { type: 'blockquote', data: { hName: 'div', hProperties: { className: ['finding-body'] } }, children: body };
  item.data = { hName: 'details', hProperties: { className: ['finding'], dataSeverity: severity } };
  item.children = body.length === 0 ? [summary as unknown as BlockContent] : [summary as unknown as BlockContent, content];
  return toString({ type: 'paragraph', children: headline }).trim();
}

/** A list item's tagged first paragraph, if it is a finding. */
function findingOf(item: ListItem): { paragraph: Paragraph; severity: Severity; holder: Paragraph | Extract<PhrasingContent, { type: 'strong' }> } | undefined {
  const paragraph = item.children[0];
  if (paragraph?.type !== 'paragraph') return undefined;
  const tag = tagOf(paragraph);
  return tag && { paragraph, ...tag };
}

/** A finding's id: `read-finding-` and its headline's first words, so a rewrite that adds a finding keeps the others'. */
const findingSlug = (headline: string) => slugOf(`finding ${headline.split(/\s+/).slice(0, 6).join(' ')}`);

/**
 * Marks a document's tree for reading, in place, and returns its outline. Every heading gets an id from its text, and
 * every finding one from its headline: never the decision card's, never one used before (a number after a repeat).
 * Sections are the second-level headings, or the first-level ones in a document with none. With `foldFindings`, each
 * list item that starts with a severity tag becomes a `<details>` folded to its headline, and a list holding any becomes
 * a `div.findings`, with a `div.findings-tools` before it for Open all (not for findings nested in a finding). Without
 * it, the tree only gains heading ids: the outline is the same either way.
 */
export function markForReading(tree: Root, foldFindings = true): Outline {
  const outline: Outline = { sections: [], leading: [] };
  const used = new Set([DECISION_ID]);
  const idFor = (base: string) => {
    let id = base;
    for (let repeat = 1; used.has(id); repeat += 1) id = `${base}-${repeat}`;
    used.add(id);
    return id;
  };
  const sectionDepth = tree.children.some((node) => node.type === 'heading' && node.depth === 2) ? 2 : 1;
  const current = () => outline.sections.at(-1)?.findings ?? outline.leading;

  const visitList = (list: List, parent: { children: Nodes[] }, index: number, inFinding: boolean) => {
    let tagged = 0;
    for (const item of list.children) {
      const found = findingOf(item);
      if (found) {
        tagged += 1;
        const target = foldFindings ? item : (structuredClone(item) as ListItem);
        const copy = foldFindings ? found : findingOf(target)!;
        const headline = fold(target, copy.paragraph, found.severity, copy.holder);
        const id = idFor(findingSlug(headline));
        if (foldFindings) item.data = { hName: 'details', hProperties: { className: ['finding'], id, dataSeverity: found.severity } };
        current().push({ id, severity: found.severity, headline });
        for (const child of (foldFindings ? item.children : item.children.slice(1)) as Nodes[]) visitChildren(child, true);
      } else {
        visitChildren(item, inFinding);
      }
    }
    if (tagged > 0 && foldFindings) {
      list.data = { hName: 'div', hProperties: { className: ['findings'] } };
      if (inFinding) return 0;
      const tools: Paragraph = { type: 'paragraph', data: { hName: 'div', hProperties: { className: ['findings-tools'], dataCount: tagged } }, children: [] };
      parent.children.splice(index, 0, tools);
      return 1;
    }
    return 0;
  };

  const visitChildren = (node: Nodes, inFinding: boolean) => {
    if (!('children' in node)) return;
    const children = node.children as Nodes[];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.type === 'heading') {
        const id = idFor(slugOf(toString(child)));
        child.data = { ...child.data, hProperties: { ...child.data?.hProperties, id } };
        if (child.depth === sectionDepth && node.type === 'root') outline.sections.push({ id, title: toString(child), findings: [] });
      } else if (child.type === 'list') {
        index += visitList(child, node as { children: Nodes[] }, index, inFinding);
      } else {
        visitChildren(child, inFinding);
      }
    }
  };
  visitChildren(tree, false);
  return outline;
}

/** The remark step the reading view renders with: headings get ids, and tagged list items fold (see markForReading). */
export function remarkFindings() {
  return (tree: Root) => {
    markForReading(tree);
  };
}
