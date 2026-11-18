import { describe, expect, it } from 'vitest';
import type { ExpandedTraceEntry } from '../../../preload/api';
import { createExpandedTrace, focusOf, triggerOf } from './expanded-trace';

const key = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}, code = '') =>
  ({ type: 'keydown', key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as unknown as Event;

describe('triggerOf', () => {
  it('names the event being handled: its type, and a key by its name, never a character typed', () => {
    expect(triggerOf(undefined)).toBe('none');
    expect(triggerOf({ type: 'click' } as Event)).toBe('click');
    expect(triggerOf(key('Escape'))).toBe('keydown Escape');
    expect(triggerOf(key('Escape', { metaKey: true }))).toBe('keydown Meta+Escape');
    expect(triggerOf(key('k', { metaKey: true }, 'KeyK'))).toBe('keydown Meta+KeyK');
    expect(triggerOf(key('a'))).toBe('keydown printable');
    expect(triggerOf(key('A', { shiftKey: true }, 'KeyA'))).toBe('keydown printable');
    expect(triggerOf(key('é', { altKey: true }, 'KeyE'))).toBe('keydown printable');
    expect(triggerOf({ type: 'some event!' } as Event)).toBe('other');
  });
});

const element = (tagName: string, inside: string[] = [], isContentEditable = false) =>
  ({ tagName, isContentEditable, closest: (selector: string) => (inside.includes(selector) ? {} : null) }) as unknown as Element;

describe('focusOf', () => {
  it('says where the keyboard is, by the kind of place only', () => {
    expect(focusOf(null)).toBe('page');
    expect(focusOf(element('BODY'))).toBe('page');
    expect(focusOf(element('TEXTAREA', ['.xterm', '.react-flow__node']))).toBe('terminal');
    expect(focusOf(element('INPUT'))).toBe('field');
    expect(focusOf(element('DIV', [], true))).toBe('field');
    expect(focusOf(element('BUTTON', ['.react-flow__node', '.react-flow']))).toBe('tile');
    expect(focusOf(element('DIV', ['.react-flow']))).toBe('board');
    expect(focusOf(element('BUTTON'))).toBe('other');
  });
});

function harness() {
  const sent: ExpandedTraceEntry[] = [];
  let clock = 0;
  let view = { x: 0, y: 0, zoom: 1 };
  let place = { trigger: 'none', focus: 'page' };
  const timers: (() => void)[] = [];
  const trace = createExpandedTrace({
    send: (entry) => sent.push(entry),
    now: () => clock,
    here: () => place,
    later: (run) => timers.push(run),
  });
  trace.watchView(() => view);
  return {
    trace,
    sent,
    tick: (ms: number) => (clock += ms),
    setView: (next: typeof view) => (view = next),
    at: (next: typeof place) => (place = next),
    runTimers: () => timers.splice(0).forEach((run) => run()),
  };
}

describe('createExpandedTrace', () => {
  it('logs a collapse with the cause noted for its tile, where it was set off, and the view then and once the board has settled', () => {
    const { trace, sent, at, setView, runTimers } = harness();
    at({ trigger: 'keydown Escape', focus: 'page' });
    trace.noteCollapse('collapseFront', ['agent-1']);
    at({ trigger: 'none', focus: 'page' });
    trace.collapsed(['agent-1']);
    setView({ x: 5, y: 0, zoom: 1 });
    expect(sent).toEqual([]);
    runTimers();
    expect(sent).toEqual([
      { kind: 'collapse', path: 'collapseFront', trigger: 'keydown Escape', focus: 'page', tiles: ['agent-1'], before: { x: 0, y: 0, zoom: 1 }, after: { x: 5, y: 0, zoom: 1 } },
    ]);
  });

  it('logs a collapse a pin refused at once, as kept, with the event that tried it; and leaves no cause for a later collapse', () => {
    const { trace, sent, at, runTimers } = harness();
    at({ trigger: 'keydown Escape', focus: 'terminal' });
    trace.kept('collapseFront', ['agent-1']);
    trace.kept('collapse', []);
    expect(sent).toEqual([{ kind: 'kept', path: 'collapseFront', trigger: 'keydown Escape', focus: 'terminal', tiles: ['agent-1'], before: { x: 0, y: 0, zoom: 1 }, after: { x: 0, y: 0, zoom: 1 } }]);
    trace.collapsed(['agent-1']);
    runTimers();
    expect(sent.at(-1)).toMatchObject({ kind: 'collapse', path: 'unexplained' });
  });

  it('logs a collapse nothing was noted for, or noted over a second before, as unexplained, with what was going on as it happened', () => {
    const { trace, sent, at, tick, runTimers } = harness();
    trace.noteCollapse('collapse', ['agent-2']);
    tick(2000);
    at({ trigger: 'none', focus: 'terminal' });
    trace.collapsed(['agent-2']);
    runTimers();
    expect(sent).toMatchObject([{ kind: 'collapse', path: 'unexplained', trigger: 'none', focus: 'terminal', tiles: ['agent-2'] }]);
  });

  it('pairs each tile with the cause noted for it, a line for each cause, and leaves no cause over for a later collapse', () => {
    const { trace, sent, runTimers } = harness();
    trace.noteCollapse('keepExpanded', ['agent-1'], 'tile-gone');
    trace.noteCollapse('windowedExpanded', ['agent-2'], 'session-window');
    trace.noteCollapse('ticketsLeavingTerminal', ['agent-9'], 'open-as-changed');
    trace.collapsed(['agent-2', 'agent-1', 'agent-3']);
    trace.collapsed(['agent-1']);
    runTimers();
    expect(sent.map((entry) => [entry.path, entry.trigger, entry.kind === 'collapse' ? entry.tiles : []])).toEqual([
      ['windowedExpanded', 'session-window', ['agent-2']],
      ['keepExpanded', 'tile-gone', ['agent-1']],
      ['unexplained', 'none', ['agent-3']],
      ['unexplained', 'none', ['agent-1']],
    ]);
  });

  it("logs a view move the board made, not the user's own pan or zoom", () => {
    const { trace, sent, at, tick } = harness();
    trace.moveStarted(true, { x: 0, y: 0, zoom: 1 });
    trace.moveEnded({ x: 50, y: 0, zoom: 1 });
    expect(sent).toEqual([]);
    at({ trigger: 'click', focus: 'tile' });
    trace.noteView('bringIntoView');
    at({ trigger: 'none', focus: 'tile' });
    // A transition starts a frame after the call that set it off.
    tick(16);
    trace.moveStarted(false, { x: 50, y: 0, zoom: 1 });
    trace.moveEnded({ x: 80, y: 10, zoom: 1.5 });
    trace.moveStarted(false, { x: 80, y: 10, zoom: 1.5 });
    trace.moveEnded({ x: 0, y: 0, zoom: 1 });
    expect(sent).toEqual([
      { kind: 'view', path: 'bringIntoView', trigger: 'click', focus: 'tile', before: { x: 50, y: 0, zoom: 1 }, after: { x: 80, y: 10, zoom: 1.5 } },
      { kind: 'view', path: 'unexplained', trigger: 'none', focus: 'tile', before: { x: 80, y: 10, zoom: 1.5 }, after: { x: 0, y: 0, zoom: 1 } },
    ]);
  });

  it("keeps each board's causes and moves to itself, a ticket board's paths named for it", () => {
    const { trace, sent, tick } = harness();
    trace.noteView('fitOnLoad', 'board', 5000);
    trace.noteView('focus', 'ticketBoard');
    tick(1500);
    trace.moveStarted(false, { x: 0, y: 0, zoom: 1 }, 'ticketBoard');
    trace.moveStarted(false, { x: 0, y: 0, zoom: 1 });
    trace.moveEnded({ x: 1, y: 1, zoom: 1 }, 'ticketBoard');
    trace.moveEnded({ x: 2, y: 2, zoom: 1 });
    expect(sent.map((entry) => entry.path)).toEqual(['ticketBoard.unexplained', 'fitOnLoad']);
  });

  it('sends nothing until it can read the view', () => {
    const sent: ExpandedTraceEntry[] = [];
    const trace = createExpandedTrace({ send: (entry) => sent.push(entry), now: () => 0, here: () => ({ trigger: 'none', focus: 'page' }), later: (run) => run() });
    trace.collapsed(['agent-1']);
    expect(sent).toEqual([]);
  });
});
