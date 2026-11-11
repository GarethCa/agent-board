import { describe, expect, it } from 'vitest';
import { draftTab, nextRegion, REGION_ORDER, unsavedIn } from './escape-hatch';

describe('F6 through the regions', () => {
  it('goes terminal, tabs, details, message box, header, then the board, as browsers and editors cycle theirs', () => {
    expect(REGION_ORDER).toEqual(['terminal', 'tabs', 'details', 'composer', 'chrome', 'board']);
  });

  it('steps to the next region shown, and back with Shift, round from the last to the first', () => {
    const shown = ['terminal', 'details', 'chrome', 'board'] as const;
    expect(nextRegion(shown, 'terminal', false)).toBe('details');
    expect(nextRegion(shown, 'details', true)).toBe('terminal');
    expect(nextRegion(shown, 'board', false)).toBe('terminal');
    expect(nextRegion(shown, 'terminal', true)).toBe('board');
  });

  it('starts at the first region from somewhere that is none of them, or the last going back', () => {
    expect(nextRegion(['terminal', 'chrome'], undefined, false)).toBe('terminal');
    expect(nextRegion(['terminal', 'chrome'], undefined, true)).toBe('chrome');
    expect(nextRegion([], undefined, false)).toBeUndefined();
  });
});

describe('leaving a window or tile with a draft in it', () => {
  it('finds an unsaved draft, which keeps Esc and ⌘Esc from leaving it', () => {
    const draft = { id: 'draft' } as unknown as Element;
    const asked: string[] = [];
    const holding = { querySelector: (selector: string) => (asked.push(selector), draft) } as unknown as ParentNode;
    expect(unsavedIn(holding)).toBe(draft);
    expect(asked).toEqual(['[data-unsaved]']);
    expect(unsavedIn({ querySelector: () => null } as unknown as ParentNode)).toBeNull();
  });
});

describe('the tab a draft is in', () => {
  const marked = (value: string | null) => ({ getAttribute: () => value });

  it('is the document or plan tab its marker names, which is shown before the draft takes the focus', () => {
    expect(draftTab(marked(JSON.stringify({ kind: 'document', sessionId: 's1', documentId: 'd1' })))).toEqual({ kind: 'document', sessionId: 's1', documentId: 'd1' });
    expect(draftTab(marked(JSON.stringify({ kind: 'plan', sessionId: 's1' })))).toEqual({ kind: 'plan', sessionId: 's1' });
  });

  it('is none for a marker that names no such tab', () => {
    expect(draftTab(marked('true'))).toBeUndefined();
    expect(draftTab(marked(''))).toBeUndefined();
    expect(draftTab(marked(null))).toBeUndefined();
    expect(draftTab(marked(JSON.stringify({ kind: 'terminal', sessionId: 's1' })))).toBeUndefined();
  });
});
