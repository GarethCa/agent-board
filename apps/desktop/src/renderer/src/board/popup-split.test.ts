import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { atRightEdge, besideCandidates, canDropInSplit, dropAtEdge, dropInSplit, openSplit, pickInSplit, selectInSplit, tabOnInSplit, type PopupSplit } from './popup-split';

const members = new Set(['chat', 'builder', 'reviewer']);
const split: PopupSplit = { right: 'builder', focused: 'left', ratio: 0.5 };

describe('opening the split', () => {
  it('puts the agent picked on the right, the one shown staying left with the focus', () => {
    expect(openSplit('chat', 'builder')).toEqual({ right: 'builder', focused: 'left', ratio: 0.5 });
  });

  it('opens nothing beside the agent itself', () => {
    expect(openSplit('chat', 'chat')).toBeUndefined();
  });

  it('opens from a tab dropped at the right edge of the body', () => {
    expect(atRightEdge(950, 1000)).toBe(true);
    expect(atRightEdge(500, 1000)).toBe(false);
    expect(atRightEdge(0, 0)).toBe(false);
    expect(dropAtEdge('chat', 'reviewer')).toEqual({ right: 'reviewer', focused: 'left', ratio: 0.5 });
  });
});

describe('a plain click on a tab in the split', () => {
  it("focuses either side's own agent", () => {
    expect(pickInSplit(split, 'chat', 'builder', members)).toEqual({ split: { ...split, focused: 'right' } });
    expect(pickInSplit({ ...split, focused: 'right' }, 'chat', 'chat', members)).toEqual({ split });
  });

  it('shows another agent in the focused pane', () => {
    expect(pickInSplit(split, 'chat', 'reviewer', members)).toEqual({ split, left: 'reviewer' });
    expect(pickInSplit({ ...split, focused: 'right' }, 'chat', 'reviewer', members)).toEqual({ split: { ...split, right: 'reviewer', focused: 'right' } });
  });

  it("shows one that isn't in the row on the right, never on the left", () => {
    expect(pickInSplit(split, 'chat', 'outsider', members)).toEqual({ split: { ...split, right: 'outsider', focused: 'right' } });
  });
});

describe('a tab dropped on a pane', () => {
  it('shows there, and that pane takes the focus', () => {
    expect(dropInSplit(split, 'chat', 'right', 'reviewer', members)).toEqual({ split: { ...split, right: 'reviewer', focused: 'right' } });
    expect(dropInSplit({ ...split, focused: 'right' }, 'chat', 'left', 'reviewer', members)).toEqual({ split, left: 'reviewer' });
  });

  it("swaps the two when it is the other side's", () => {
    expect(dropInSplit(split, 'chat', 'right', 'chat', members)).toEqual({ split: { ...split, right: 'chat', focused: 'right' }, left: 'builder' });
    expect(dropInSplit(split, 'chat', 'left', 'builder', members)).toEqual({ split: { ...split, right: 'chat', focused: 'left' }, left: 'builder' });
  });

  it("never puts one that isn't in the row on the left", () => {
    const outside = { ...split, right: 'outsider' };
    expect(dropInSplit(outside, 'chat', 'right', 'chat', members)).toEqual({ split: outside });
    expect(dropInSplit(outside, 'chat', 'left', 'outsider', members)).toEqual({ split: outside });
  });
});

describe('what Open beside… lists', () => {
  const agent = (sessionId: string, more: Partial<Agent> = {}) => ({ sessionId, zoneId: 'z1', endedAt: null, ...more }) as Agent;
  const chat = agent('chat');
  const builder = agent('builder');
  const reviewer = agent('reviewer');
  const other = agent('other');
  const ended = agent('ended', { endedAt: '2026-11-20T10:00:00Z' });
  const elsewhere = agent('elsewhere', { zoneId: 'z2' });
  const agents = [chat, builder, reviewer, other, ended, elsewhere];
  const ids = (list: readonly Agent[]) => list.map((each) => each.sessionId);

  it("lists the ticket's helpers first, then the other agents running in its zone", () => {
    expect(ids(besideCandidates({ shown: chat, row: [chat, reviewer, builder], agents }))).toEqual(['reviewer', 'builder', 'other']);
  });

  it('leaves out the agent shown, the one beside it already, and a helper popped out', () => {
    expect(ids(besideCandidates({ shown: builder, row: [chat, reviewer, builder], agents, popped: ['reviewer'], right: 'other' }))).toEqual(['chat']);
  });

  it('lists the zone for one agent alone, and nothing for one in no zone', () => {
    expect(ids(besideCandidates({ shown: other, row: [other], agents }))).toEqual(['chat', 'builder', 'reviewer']);
    const loose = agent('loose', { zoneId: null });
    expect(besideCandidates({ shown: loose, row: [loose], agents: [...agents, agent('loose2', { zoneId: null })] })).toEqual([]);
  });
});

describe('a tab picked while split, by a click or the row keys', () => {
  it("never ends the split going to either side's tab, only moving the focus", () => {
    expect(selectInSplit(split, 'chat', 'builder', members, true)).toEqual({ split: { ...split, focused: 'right' } });
    expect(selectInSplit({ ...split, focused: 'right' }, 'chat', 'chat', members, true)).toEqual({ split });
  });

  it('shows another agent in the pane with the focus', () => {
    expect(selectInSplit(split, 'chat', 'reviewer', members, true)).toEqual({ split, left: 'reviewer' });
    expect(selectInSplit({ ...split, focused: 'right' }, 'chat', 'reviewer', members, true)).toEqual({ split: { ...split, right: 'reviewer', focused: 'right' } });
  });

  it('shows a view or a shell on the left, which takes the focus, so its tab is the one on', () => {
    const step = selectInSplit({ ...split, focused: 'right' }, 'chat', 'board', members, false);
    expect(step).toEqual({ split, left: 'board' });
    expect(tabOnInSplit(step.split!, 'board')).toBe('board');
  });

  it("has the right's tab on while the right has the focus, else the left pane's", () => {
    expect(tabOnInSplit({ ...split, focused: 'right' }, 'chat')).toBe('builder');
    expect(tabOnInSplit(split, 'shell:1')).toBe('shell:1');
  });
});

describe('where a dragged tab can drop', () => {
  it("takes only an agent's tab", () => {
    expect(canDropInSplit(undefined, 'chat', 'edge', 'board', members, false)).toBe(false);
    expect(canDropInSplit(split, 'chat', 'right', 'shell:1', members, false)).toBe(false);
  });

  it('opens beside at the edge, never the agent shown itself', () => {
    expect(canDropInSplit(undefined, 'chat', 'edge', 'builder', members, true)).toBe(true);
    expect(canDropInSplit(undefined, 'chat', 'edge', 'chat', members, true)).toBe(false);
  });

  it('split, takes any agent on the right and only a member of the row on the left', () => {
    expect(canDropInSplit(split, 'chat', 'right', 'other', members, true)).toBe(true);
    expect(canDropInSplit(split, 'chat', 'left', 'reviewer', members, true)).toBe(true);
    expect(canDropInSplit(split, 'chat', 'left', 'other', members, true)).toBe(false);
    expect(canDropInSplit(split, 'chat', 'edge', 'reviewer', members, true)).toBe(false);
  });
});
