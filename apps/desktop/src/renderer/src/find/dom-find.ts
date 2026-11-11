import type { FindResult, FindStep } from '../../../preload/api';

/** Searches something shown: `first` starts a search at `text`, `next` and `previous` move on from the match shown. */
export interface Finder {
  search(text: string, step: FindStep): Promise<FindResult>;
  /** Takes the highlights away. */
  clear(): void;
  /** Gives the keyboard back to what was searched, when the bar closes. */
  focus?(): void;
  /** Takes the keyboard from what was searched, when the bar opens: a web page keeps it until told. */
  takeKeyboard?(): void;
}

/** `text` in lower case, a character at a time, so every offset in it is the offset in `text`: one whose lower case is longer or shorter stays as it is. */
function fold(text: string): string {
  let folded = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/** Where `query` starts in `text`, any case, without overlapping itself. */
export function matchOffsets(text: string, query: string): number[] {
  const needle = fold(query);
  if (needle === '') return [];
  const lower = fold(text);
  const at: number[] = [];
  for (let found = lower.indexOf(needle); found >= 0; found = lower.indexOf(needle, found + needle.length)) at.push(found);
  return at;
}

/** Every place `query` is in the text under `root`, any case, as ranges; a match is never split across two elements. */
function textRanges(root: Node, query: string): Range[] {
  const ranges: Range[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    for (const at of matchOffsets(node.textContent!, query)) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Where a step from `index` lands among `total` matches, wrapping round either end. */
export function stepIndex(index: number, total: number, step: FindStep): number {
  if (total === 0 || step === 'first') return 0;
  return (index + (step === 'next' ? 1 : -1) + total) % total;
}

/** What each open finder has found: the document's two highlights are drawn from all of them, so one finder never wipes another's. */
const shown = new Map<object, { all: Range[]; active: Range[] }>();

function paint(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (shown.size === 0) {
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-active');
    return;
  }
  const each = [...shown.values()];
  CSS.highlights.set('find', new Highlight(...each.flatMap((one) => one.all)));
  CSS.highlights.set('find-active', new Highlight(...each.flatMap((one) => one.active)));
}

/** Finds in the text of the element `getRoot` returns, drawing the matches with the CSS highlights `find` and `find-active`. */
export function domFinder(getRoot: () => Element | null): Finder {
  const mine = {};
  let query = '';
  let ranges: Range[] = [];
  let index = 0;
  const show = () => {
    shown.set(mine, { all: ranges, active: ranges.slice(index, index + 1) });
    paint();
  };
  const clear = () => {
    ranges = [];
    shown.delete(mine);
    paint();
  };
  return {
    search(text, step) {
      try {
        const root = getRoot();
        const build = () => (root === null ? [] : textRanges(root, query));
        if (step === 'first') {
          query = text;
          ranges = build();
          index = 0;
        } else {
          // The document drawn again under the bar leaves collapsed ranges: search again, from near where the match was.
          if (ranges.length === 0 || ranges.some((range) => range.collapsed)) {
            ranges = build();
            index = Math.min(index, Math.max(ranges.length - 1, 0));
          }
          index = stepIndex(index, ranges.length, step);
        }
        show();
        ranges[index]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
        return Promise.resolve({ active: ranges.length === 0 ? 0 : index + 1, total: ranges.length });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    clear,
  };
}
