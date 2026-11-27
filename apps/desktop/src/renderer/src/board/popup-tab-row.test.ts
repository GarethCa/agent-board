import { describe, expect, it } from 'vitest';
import { afterClose, closedView, foldRow, keptOrders, movedTab, openedView, popUpRowKey, rowOrder, shellDragOf, soloRow, steppedTab, viewRow, withKeptOrder } from './popup-tab-row';

const tab = (key: string, kind: 'view' | 'agent' | 'shell' = 'agent') => ({ key, kind });
const keys = (tabs: readonly { key: string }[]) => tabs.map(({ key }) => key);

describe('rowOrder', () => {
  const row = [tab('board', 'view'), tab('chat'), tab('builder'), tab('reviewer'), tab('zsh', 'shell')];

  it('puts the view first, then the agents, then the shells, when nothing was dragged', () => {
    const mixed = [tab('zsh', 'shell'), tab('chat'), tab('board', 'view'), tab('builder')];
    expect(keys(rowOrder(mixed, undefined))).toEqual(['board', 'chat', 'builder', 'zsh']);
  });

  it('keeps the order the tabs were dragged into', () => {
    expect(keys(rowOrder(row, ['reviewer', 'board', 'zsh', 'chat', 'builder']))).toEqual(['reviewer', 'board', 'zsh', 'chat', 'builder']);
  });

  it('drops a kept tab that has gone and puts a new one where it would go with nothing dragged', () => {
    // The reviewer is new: it goes after the builder, the tab before it in the plain order.
    expect(keys(rowOrder(row, ['builder', 'gone', 'board', 'chat', 'zsh']))).toEqual(['builder', 'reviewer', 'board', 'chat', 'zsh']);
  });

  it('puts a new tab first when nothing before it in the plain order is kept', () => {
    expect(keys(rowOrder(row, ['chat', 'builder', 'reviewer', 'zsh']))).toEqual(['board', 'chat', 'builder', 'reviewer', 'zsh']);
  });
});

describe('shellDragOf', () => {
  const dragOf = (key: string) => `drag of ${key}`;

  it('lets only the shells drag out of the row where shells are let out', () => {
    const of = shellDragOf(true, ['zsh'], dragOf)!;
    expect(of('zsh')).toBe('drag of zsh');
    expect(of('builder')).toBeUndefined();
    expect(of('board')).toBeUndefined();
  });

  it("lets nothing drag out of a pop-up's row, or of a row with nothing to drag", () => {
    expect(shellDragOf(false, ['zsh'], dragOf)).toBeUndefined();
    expect(shellDragOf(true, ['zsh'], undefined)).toBeUndefined();
  });
});

describe('movedTab', () => {
  const order = ['board', 'chat', 'builder', 'reviewer'];

  it('moves a tab right, to the slot before the tab it was let go on', () => {
    // Let go over the reviewer's left half: slot 3, before the reviewer.
    expect(movedTab(order, 'chat', 3)).toEqual(['board', 'builder', 'chat', 'reviewer']);
  });

  it('moves a tab left, and to the end', () => {
    expect(movedTab(order, 'reviewer', 0)).toEqual(['reviewer', 'board', 'chat', 'builder']);
    expect(movedTab(order, 'board', 4)).toEqual(['chat', 'builder', 'reviewer', 'board']);
  });

  it('leaves the row as it was when let go beside itself, or for a tab it does not have', () => {
    expect(movedTab(order, 'chat', 1)).toEqual(order);
    expect(movedTab(order, 'chat', 2)).toEqual(order);
    expect(movedTab(order, 'gone', 0)).toEqual(order);
  });
});

describe('foldRow', () => {
  const row = (...widths: number[]) => widths.map((width, index) => ({ key: `t${index}`, width }));

  it('folds nothing when the row fits', () => {
    expect(foldRow(row(100, 100, 100), { room: 300, more: 40, keep: new Set() })).toEqual({ shown: ['t0', 't1', 't2'], folded: [] });
  });

  it('folds the last tabs first, leaving room for its "+n"', () => {
    // 400 of tabs in 300: fold t3 (300 left, no room for the 40 of "+1"), then t2 (200 + 40 fits).
    expect(foldRow(row(100, 100, 100, 100), { room: 300, more: 40, keep: new Set() })).toEqual({ shown: ['t0', 't1'], folded: ['t2', 't3'] });
  });

  it('never folds the tab that is on or an amber one, folding the ones before them instead', () => {
    expect(foldRow(row(100, 100, 100, 100), { room: 300, more: 40, keep: new Set(['t3', 't2']) })).toEqual({ shown: ['t2', 't3'], folded: ['t0', 't1'] });
  });

  it('shows every tab it must keep even when they overflow', () => {
    expect(foldRow(row(200, 200, 200), { room: 300, more: 40, keep: new Set(['t0', 't2']) })).toEqual({ shown: ['t0', 't2'], folded: ['t1'] });
  });
});

describe('the row\'s keys', () => {
  const order = ['board', 'chat', 'builder'];

  it('⌃Tab steps to the next tab, round from the last to the first, and ⌃⇧Tab back', () => {
    expect(steppedTab(order, 'chat', 1)).toBe('builder');
    expect(steppedTab(order, 'builder', 1)).toBe('board');
    expect(steppedTab(order, 'board', -1)).toBe('builder');
  });

  it('steps past a tab it is told to skip, a helper in a window of its own, both ways', () => {
    const row = ['board', 'chat', 'builder', 'reviewer'];
    const popped = new Set(['builder']);
    expect(steppedTab(row, 'chat', 1, popped)).toBe('reviewer');
    expect(steppedTab(row, 'reviewer', -1, popped)).toBe('chat');
    expect(steppedTab(['chat', 'builder'], 'chat', 1, popped)).toBe('chat');
  });

  const press = (code: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
    key: code === 'Tab' ? 'Tab' : code === 'BracketLeft' ? '[' : code.slice(-1),
    code,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...held,
  });
  const on = { isMac: true, extended: true };

  it('reads ⌃Tab and ⌃⇧Tab as a step along the row, ⌘[ as back to the tab before, and ⌘1–⌘9 as a place in it', () => {
    expect(popUpRowKey(press('Tab', { ctrlKey: true }), on)).toEqual({ kind: 'step', step: 1 });
    expect(popUpRowKey(press('Tab', { ctrlKey: true, shiftKey: true }), on)).toEqual({ kind: 'step', step: -1 });
    expect(popUpRowKey(press('BracketLeft', { metaKey: true }), on)).toEqual({ kind: 'back' });
    expect(popUpRowKey(press('Digit3', { metaKey: true }), on)).toEqual({ kind: 'tab', digit: 3 });
    expect(popUpRowKey(press('Digit3', { ctrlKey: true, shiftKey: true }), { isMac: false, extended: true })).toEqual({ kind: 'tab', digit: 3 });
  });

  it('leaves every other key to the session under it', () => {
    expect(popUpRowKey(press('Tab'), on)).toBeUndefined();
    expect(popUpRowKey(press('KeyT', { metaKey: true }), on)).toBeUndefined();
    expect(popUpRowKey(press('Digit0', { metaKey: true }), on)).toBeUndefined();
  });
});

describe('kept orders', () => {
  it('reads each owner\'s kept order from the saved view state, passing over anything else', () => {
    expect(keptOrders({ 'ticket:a': ['board', 'chat'], 'crew:b': 'nope', 'flow:c': [1, 'x'] })).toEqual({ 'ticket:a': ['board', 'chat'] });
    expect(keptOrders(undefined)).toEqual({});
    expect(keptOrders(['a'])).toEqual({});
  });

  it('keeps an owner\'s new order beside the others', () => {
    expect(withKeptOrder({ 'ticket:a': ['x'] }, 'ticket:b', ['chat', 'board'])).toEqual({ 'ticket:a': ['x'], 'ticket:b': ['chat', 'board'] });
  });

  it('keeps the owners dragged most lately, the latest last, and lets the oldest go past the most it keeps', () => {
    const orders = { 'ticket:a': ['x'], 'ticket:b': ['y'], 'ticket:c': ['z'] };
    expect(Object.keys(withKeptOrder(orders, 'ticket:a', ['w'], 3))).toEqual(['ticket:b', 'ticket:c', 'ticket:a']);
    expect(withKeptOrder(orders, 'ticket:d', ['v'], 3)).toEqual({ 'ticket:b': ['y'], 'ticket:c': ['z'], 'ticket:d': ['v'] });
  });
});

describe('a view opened from the sidebar', () => {
  it('opens as a tab at the end of the views open', () => {
    expect(openedView([], 'activity')).toEqual(['activity']);
    expect(openedView(['board'], 'review')).toEqual(['board', 'review']);
  });

  it('goes to its tab when it is open already, never a second one', () => {
    const open = ['board', 'review'];
    expect(openedView(open, 'board')).toEqual(['board', 'review']);
    expect(openedView(openedView(open, 'review'), 'review')).toEqual(['board', 'review']);
  });

  it('closes by its ×, and the others stay as they were', () => {
    expect(closedView(['board', 'review', 'activity'], 'review')).toEqual(['board', 'activity']);
    expect(closedView(['board'], 'review')).toEqual(['board']);
  });

  it('closing the tab on goes back to the one it came from, else to the agent shown under the views, not the chat', () => {
    const order = ['board', 'activity', 'chat', 'builder'];
    expect(afterClose('activity', { active: 'activity', from: 'board', order, under: 'builder' })).toBe('board');
    // Came from nothing still in the row: back to the builder's terminal, as it was.
    expect(afterClose('board', { active: 'board', from: undefined, order, under: 'builder' })).toBe('builder');
    expect(afterClose('board', { active: 'board', from: 'gone', order, under: 'builder' })).toBe('builder');
    // A tab not on closes with the one on staying.
    expect(afterClose('activity', { active: 'chat', from: 'board', order, under: 'chat' })).toBe('chat');
  });

  it("reads on in the sidebar when its tab is on, open (the dot) when it is a tab not on, else closed", () => {
    expect(viewRow('review', ['board', 'review'], 'review')).toBe('on');
    expect(viewRow('board', ['board', 'review'], 'review')).toBe('open');
    expect(viewRow('activity', ['board', 'review'], 'review')).toBe('closed');
  });
});

describe("one agent's row", () => {
  it('has no row while its own tab is the only one, its tab named by the header', () => {
    expect(soloRow([tab('a1')])).toEqual({ shows: false, ownLabel: undefined });
  });

  it('shows the row once a second tab opens, a view or a shell, its own tab then named for the view it shows', () => {
    expect(soloRow([tab('a1'), tab('activity', 'view')])).toEqual({ shows: true, ownLabel: 'Terminal' });
    expect(soloRow([tab('a1'), tab('zsh', 'shell')], 'chat')).toEqual({ shows: true, ownLabel: 'Chat' });
  });

  it('goes back to no row once the last other tab closes', () => {
    const open = closedView(openedView([], 'activity'), 'activity');
    expect(soloRow([tab('a1'), ...open.map((key) => tab(key, 'view'))]).shows).toBe(false);
  });
});
