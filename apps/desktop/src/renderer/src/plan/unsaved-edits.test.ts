import { describe, expect, it } from 'vitest';
import { hasUnsavedEdit, heardUnsavedEdits, markUnsavedEdit, subscribeUnsavedEdits } from './unsaved-edits';

describe('unsaved edits of plans, which hold every decision on them in every window', () => {
  it('holds a plan while its Plan tab has a changed draft, and lets it go once saved, cancelled or unchanged', () => {
    const heard: number[] = [];
    const stop = subscribeUnsavedEdits(() => heard.push(heard.length));
    markUnsavedEdit('s1', 'p1', true);
    expect(hasUnsavedEdit('s1', 'p1')).toBe(true);
    // Only that version of that agent's plan.
    expect(hasUnsavedEdit('s1', 'p2')).toBe(false);
    expect(hasUnsavedEdit('s2', 'p1')).toBe(false);
    markUnsavedEdit('s1', 'p1', true);
    markUnsavedEdit('s1', 'p1', false);
    expect(hasUnsavedEdit('s1', 'p1')).toBe(false);
    stop();
    markUnsavedEdit('s1', 'p1', true);
    // Told once each time it changed, and no more once unsubscribed.
    expect(heard).toEqual([0, 1]);
    markUnsavedEdit('s1', 'p1', false);
  });

  it('holds a plan whose draft is in another window, as main tells it, and lets it go once main says so', () => {
    // A popped-out Plan tab's draft: this window has none of its own.
    heardUnsavedEdits(['s1:p7']);
    expect(hasUnsavedEdit('s1', 'p7')).toBe(true);
    heardUnsavedEdits([]);
    expect(hasUnsavedEdit('s1', 'p7')).toBe(false);
  });
});
