import { describe, expect, it } from 'vitest';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  neighbourOf,
  paneIds,
  parsePaneLayout,
  setPaneName,
  removePane,
  setSplitRatio,
  splitPane,
  type PaneLayout,
} from '../src/pane-layout.ts';

const pane = (sessionId: string): PaneLayout => ({ type: 'pane', sessionId });

describe('pane layout', () => {
  it('splits a pane, the new one second and the split at half', () => {
    const layout = splitPane(pane('a'), 'a', 'horizontal', 'b', 's1');
    expect(layout).toEqual({ type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5, first: pane('a'), second: pane('b') });
  });

  it('splits a pane inside a split, leaving the rest alone', () => {
    const two = splitPane(pane('a'), 'a', 'horizontal', 'b', 's1');
    const three = splitPane(two, 'b', 'vertical', 'c', 's2');
    expect(paneIds(three)).toEqual(['a', 'b', 'c']);
    expect(three).toMatchObject({ id: 's1', first: pane('a'), second: { id: 's2', direction: 'vertical', first: pane('b'), second: pane('c') } });
  });

  it('labels a pane, which splits and removals keep, and clears the label with an empty name', () => {
    const labelled = setPaneName(pane('a'), 'a', 'logs');
    expect(labelled).toEqual({ type: 'pane', sessionId: 'a', name: 'logs' });
    const two = splitPane(labelled, 'a', 'horizontal', 'b', 's1');
    expect(two).toMatchObject({ first: { name: 'logs' }, second: pane('b') });
    expect(parsePaneLayout(JSON.parse(JSON.stringify(two)))).toEqual(two);
    expect(removePane(two, 'b')).toEqual(labelled);
    expect(setPaneName(two, 'a', '')).toEqual(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'));
    expect(() => setPaneName(two, 'x', 'n')).toThrow(/no pane x/);
  });

  it('refuses to split a pane it does not have', () => {
    expect(() => splitPane(pane('a'), 'x', 'vertical', 'b', 's1')).toThrow(/no pane x/);
  });

  it('closes a pane: its sibling takes the split’s place', () => {
    const three = splitPane(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'), 'b', 'vertical', 'c', 's2');
    expect(removePane(three, 'b')).toEqual({ type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5, first: pane('a'), second: pane('c') });
    expect(removePane(three, 'a')).toEqual(three.type === 'split' ? three.second : null);
  });

  it('names the pane next to a closing one, on the side that takes its space', () => {
    const three = splitPane(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'), 'b', 'vertical', 'c', 's2');
    expect(neighbourOf(three, 'c')).toBe('b');
    expect(neighbourOf(three, 'b')).toBe('c');
    // The right half takes a's space: its pane nearest a.
    expect(neighbourOf(three, 'a')).toBe('b');
    const leftHeavy = splitPane(splitPane(pane('a'), 'a', 'horizontal', 'c', 's1'), 'a', 'vertical', 'b', 's2');
    expect(neighbourOf(leftHeavy, 'c')).toBe('b');
    expect(neighbourOf(pane('a'), 'a')).toBeUndefined();
    expect(neighbourOf(three, 'x')).toBeUndefined();
  });

  it('closing the only pane leaves no layout; closing an unknown pane changes nothing', () => {
    expect(removePane(pane('a'), 'a')).toBeNull();
    expect(removePane(pane('a'), 'x')).toEqual(pane('a'));
  });

  it('resizes a split, keeping both sides usable', () => {
    const two = splitPane(pane('a'), 'a', 'horizontal', 'b', 's1');
    expect(setSplitRatio(two, 's1', 0.7)).toMatchObject({ ratio: 0.7 });
    expect(setSplitRatio(two, 's1', 0)).toMatchObject({ ratio: MIN_SPLIT_RATIO });
    expect(setSplitRatio(two, 's1', 5)).toMatchObject({ ratio: MAX_SPLIT_RATIO });
    expect(() => setSplitRatio(two, 'nope', 0.5)).toThrow(/no split nope/);
  });

  it('parses what it wrote, and refuses anything else', () => {
    const layout = splitPane(pane('a'), 'a', 'vertical', 'b', 's1');
    expect(parsePaneLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    for (const bad of [null, 'x', {}, { type: 'pane' }, { type: 'split', id: 's', direction: 'diagonal', ratio: 0.5, first: pane('a'), second: pane('b') }]) {
      expect(() => parsePaneLayout(bad)).toThrow(/pane layout/);
    }
  });
});
