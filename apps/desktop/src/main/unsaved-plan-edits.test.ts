import { describe, expect, it, vi } from 'vitest';
import { createUnsavedPlanEdits } from './unsaved-plan-edits';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

describe('unsaved plan edits, relayed to every window', () => {
  it('tells every window the edits unsaved in any of them, until each is saved or its window goes', () => {
    const sent: string[][] = [];
    const edits = createUnsavedPlanEdits((keys) => sent.push(keys));

    // A popped-out Plan tab (window 7) changes its draft: the board's window hears it.
    edits.mark(7, 's1', 'p1', true);
    expect(sent.at(-1)).toEqual(['s1:p1']);
    edits.mark(3, 's2', 'p9', true);
    expect(sent.at(-1)).toEqual(['s1:p1', 's2:p9']);
    expect(edits.keys()).toEqual(['s1:p1', 's2:p9']);

    // The same mark again says nothing new.
    const told = sent.length;
    edits.mark(7, 's1', 'p1', true);
    expect(sent).toHaveLength(told);

    // Saved, or its window closed with the draft in it: the hold goes.
    edits.mark(3, 's2', 'p9', false);
    expect(sent.at(-1)).toEqual(['s1:p1']);
    edits.windowGone(7);
    expect(sent.at(-1)).toEqual([]);
    edits.windowGone(7);
    expect(sent.at(-1)).toEqual([]);
  });

  it('holds a plan while any window still has an unsaved edit of it', () => {
    const sent: string[][] = [];
    const edits = createUnsavedPlanEdits((keys) => sent.push(keys));
    edits.mark(1, 's1', 'p1', true);
    edits.mark(2, 's1', 'p1', true);
    edits.mark(1, 's1', 'p1', false);
    expect(edits.keys()).toEqual(['s1:p1']);
    edits.windowGone(2);
    expect(edits.keys()).toEqual([]);
  });
});
