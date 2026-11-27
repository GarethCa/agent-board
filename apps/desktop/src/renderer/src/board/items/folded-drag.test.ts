import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StepsData, TodoData } from '@agent-board/daemon/protocol';
import { MemoryIconView } from './MemoryCard';
import { QueueIconView } from './QueueCard';
import { StepsCard } from './StepsCard';
import { TodoPillView } from './TodoCard';
import { NO_LOOKUP } from './todo-view';

// A folded list card drags by what is drawn, as it does open: React Flow starts no drag from inside a `nodrag`
// element, so only its small controls may carry the class, never its face or the whole of it.

/** The class lists of the elements in `element`'s markup that opt out of dragging. */
function noDrag(element: ReactElement): string[] {
  const html = renderToStaticMarkup(element);
  return [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!).filter((classes) => classes.split(' ').includes('nodrag'));
}

const AT = '2026-01-01T00:00:00.000Z';
const list = { title: 'Facts', scope: 'Board', count: 2, onOpen: () => {} };

describe('a folded list card has no nodrag over its face', () => {
  it('a memory folded to its icon: nothing in it is nodrag', () => {
    expect(noDrag(createElement(MemoryIconView, list))).toEqual([]);
  });

  it('a queue folded to its icon, for the user or an agent: nothing in it is nodrag', () => {
    expect(noDrag(createElement(QueueIconView, { ...list, audience: 'user' }))).toEqual([]);
    expect(noDrag(createElement(QueueIconView, { ...list, audience: 'agents' }))).toEqual([]);
  });

  it('a to-do list folded to its pill: only its Unfold and Clear buttons are nodrag, not its face', () => {
    const open: TodoData = { owner: { kind: 'user' }, lines: [{ id: 't1', text: 'A line', by: { kind: 'user' }, at: AT, done: null }] };
    const done: TodoData = { ...open, lines: [{ ...open.lines[0]!, done: { by: { kind: 'user' }, at: AT } }] };
    const pill = (data: TodoData) => createElement(TodoPillView, { data, lookup: NO_LOOKUP, onOpen: () => {}, onUnfold: () => {}, onClear: () => {} });
    expect(noDrag(pill(open))).toEqual(['todo-pill-open nodrag']);
    expect(noDrag(pill(done))).toEqual(['todo-pill-clear nodrag', 'todo-pill-open nodrag']);
  });

  it('a steps card folded to its icon: nothing in it is nodrag', () => {
    const data: StepsData = { title: 'Release', madeBy: { kind: 'user' }, answeredBy: { kind: 'user' }, steps: [], sent: null, waits: [], closedAt: null };
    const actions = { answer: () => {}, tick: () => {}, send: () => {}, stepIn: () => {}, leave: () => {} };
    const icon = createElement(StepsCard, { data, lookup: { live: () => true, name: (id: string) => id }, look: 'icon', selected: false, sized: false, steppedIn: false, writing: false, actions });
    expect(noDrag(icon)).toEqual([]);
  });
});
