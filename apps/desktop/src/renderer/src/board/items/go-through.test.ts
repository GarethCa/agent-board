import { describe, expect, it } from 'vitest';
import type { QueueJob } from '@agent-board/daemon/protocol';
import { FIRST_PLACE, goThroughKey, leavesArrowToGoingThrough, nextPlace, placeAfterDone, placeIn } from './go-through';
import { lookItems, lookKey, type LookItem } from './to-look-at';

const job = (id: string) => ({ id, text: `item ${id}`, link: null, state: 'queued', kind: 'backlog' }) as QueueJob;
const items = (...ids: string[]): LookItem[] => lookItems(ids.map(job), []);
const shown = (list: LookItem[], index: number) => (index < 0 ? undefined : lookKey(list[index]!));

describe('going through a queue in its tile', () => {
  it('starts at the first, and keeps showing the same thing when a row is put in front of it', () => {
    expect(shown(items('a', 'b'), placeIn(items('a', 'b'), FIRST_PLACE))).toBe('a');
    const place = nextPlace(items('a', 'b', 'c'), 0);
    expect(shown(items('a', 'b', 'c'), placeIn(items('a', 'b', 'c'), place))).toBe('b');
    expect(shown(items('z', 'a', 'b', 'c'), placeIn(items('z', 'a', 'b', 'c'), place))).toBe('b');
  });

  it('goes round to the first after the last on Next', () => {
    expect(nextPlace(items('a', 'b'), 1)).toEqual({ key: 'a', index: 0 });
  });

  it('shows the one after a skipped thing, though the skipped one is still there, now last', () => {
    const before = items('a', 'b', 'c');
    const place = nextPlace(before, 0);
    expect(shown(items('b', 'c', 'a'), placeIn(items('b', 'c', 'a'), place))).toBe('b');
  });

  it('shows the one after a thing done, or the one before it when it was the last', () => {
    const place = placeAfterDone(items('a', 'b', 'c'), 1);
    expect(shown(items('a', 'c'), placeIn(items('a', 'c'), place))).toBe('c');
    const last = placeAfterDone(items('a', 'b'), 1);
    expect(shown(items('a'), placeIn(items('a'), last))).toBe('a');
  });

  it('falls back to its place when the thing shown goes elsewhere, and shows nothing once the queue is empty', () => {
    expect(shown(items('a', 'c'), placeIn(items('a', 'c'), { key: 'b', index: 1 }))).toBe('c');
    expect(shown(items('a'), placeIn(items('a'), { key: 'b', index: 4 }))).toBe('a');
    expect(placeIn([], { key: 'a', index: 0 })).toBe(-1);
  });
});

/** An element for the key checks: its tag, and the selectors it is inside. */
const element = (tagName: string, inside: string[] = [], fields: { isContentEditable?: boolean } = {}) => ({
  tagName,
  ...fields,
  closest: (selector: string) => (selector.split(',').some((one) => inside.includes(one.trim())) ? {} : null),
});
const key = (name: string, target: unknown, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
  target,
});

describe('the keys a tile going through its queue takes', () => {
  const onTile = element('DIV', ['.react-flow', '.react-flow__node']);
  const tile = { contains: (node: unknown) => node === onTile || node === button };
  const button = element('BUTTON', ['.react-flow', '.react-flow__node']);

  it('takes ↵, →, S and D pressed on it or on the bare board', () => {
    expect(['Enter', 'ArrowRight', 's', 'D'].map((name) => goThroughKey(key(name, onTile), tile))).toEqual(['open', 'next', 'skip', 'done']);
    expect(goThroughKey(key('d', element('BODY')), tile)).toBe('done');
    expect(goThroughKey(key('s', element('DIV', ['.react-flow'])), tile)).toBe('skip');
  });

  it('leaves other keys, and any with ⌘, ⌃ or ⌥, to the board', () => {
    expect(goThroughKey(key('x', onTile), tile)).toBeUndefined();
    expect(goThroughKey(key('d', onTile, { metaKey: true }), tile)).toBeUndefined();
    expect(goThroughKey(key('s', onTile, { ctrlKey: true }), tile)).toBeUndefined();
    expect(goThroughKey(key('ArrowRight', onTile, { altKey: true }), tile)).toBeUndefined();
  });

  it('never takes a key typed in a field, a terminal or another tile, or pressed in a panel off the board', () => {
    expect(goThroughKey(key('d', element('TEXTAREA', ['.react-flow', '.react-flow__node'])), tile)).toBeUndefined();
    expect(goThroughKey(key('s', element('INPUT')), tile)).toBeUndefined();
    expect(goThroughKey(key('d', element('DIV', ['[data-keys-own]', '.react-flow', '.react-flow__node'])), tile)).toBeUndefined();
    expect(goThroughKey(key('d', element('DIV', [], { isContentEditable: true })), tile)).toBeUndefined();
    expect(goThroughKey(key('d', element('DIV', ['.react-flow', '.react-flow__node'])), tile)).toBeUndefined();
    expect(goThroughKey(key('Enter', element('BUTTON', ['.master-panel'])), tile)).toBeUndefined();
  });

  it('leaves ↵ to a focused button on the tile, which presses itself', () => {
    expect(goThroughKey(key('Enter', button), tile)).toBeUndefined();
    expect(goThroughKey(key('d', button), tile)).toBe('done');
  });
});

describe('the board nudging a tile going through its queue with the arrow keys', () => {
  it('leaves → to the tile when it alone is selected, so → goes on to the next', () => {
    expect(leavesArrowToGoingThrough('ArrowRight', ['queue'], 'queue')).toBe(true);
  });

  it('still nudges with the other arrows, with more selected, and any tile not going through', () => {
    expect(leavesArrowToGoingThrough('ArrowLeft', ['queue'], 'queue')).toBe(false);
    expect(leavesArrowToGoingThrough('ArrowRight', ['queue', 'note'], 'queue')).toBe(false);
    expect(leavesArrowToGoingThrough('ArrowRight', ['note'], 'queue')).toBe(false);
    expect(leavesArrowToGoingThrough('ArrowRight', ['queue'], undefined)).toBe(false);
  });
});
