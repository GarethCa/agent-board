import { describe, expect, it } from 'vitest';
import type { FlowEdge } from '@agent-board/daemon/protocol';
import { railMoved, railMoveRefused, railOf, railsOf, railToken, tokenSlots, withRailSelected, type Rail } from './rails';

/** A time on the day of these tests, by the local clock: the token says it so. */
const at = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes).toISOString();

const edge = (id: string, from: string, to: string, overrides: Partial<FlowEdge> = {}): FlowEdge => ({
  id,
  from,
  to,
  trigger: 'auto',
  payload: 'final-message',
  path: null,
  conditions: [],
  checks: [],
  held: null,
  deliverAs: 'message',
  queued: null,
  paused: false,
  lastDelivery: null,
  history: [],
  deliveries: 0,
  delivering: false,
  madeBy: null,
  oneOff: false,
  fromSide: 'auto',
  toSide: 'auto',
  style: 'curved',
  points: [],
  createdAt: at(14, 0),
  updatedAt: '',
  ...overrides,
});

const delivered = (at: string, count = 1): Partial<FlowEdge> => ({ lastDelivery: { at, delivered: true, reason: null }, deliveries: count });

/** The implementer hands its handover to the reviewer by itself; the reviewer's review goes back when the user sends it. */
const handover = (overrides: Partial<FlowEdge> = {}) => edge('handover', 'impl', 'rev', { payload: 'handover', path: 'handover.md', ...overrides });
const review = (overrides: Partial<FlowEdge> = {}) =>
  edge('review', 'rev', 'impl', { trigger: 'manual', payload: 'handover', path: 'review.md', createdAt: at(14, 1), ...overrides });

const pair = (...edges: FlowEdge[]): Rail => railsOf(edges)[0]!;
const NOW = new Date(2026, 9, 15, 15, 0);
/** `ready`: the agents done with their turn, each with when it last ended (null: not known). */
const token = (rail: Rail, { live = [] as string[], ready = {} as Record<string, string | null> } = {}) =>
  railToken(rail, { live: new Set(live), ready: new Map(Object.entries(ready)), now: NOW });

describe('railsOf', () => {
  it('draws one rail for two agents joined both ways, from the end of the edge made first, and one for each one-way edge', () => {
    const rails = railsOf([review(), edge('verdict', 'rev', 'merge'), handover()]);

    expect(rails).toEqual([
      { id: 'handover', from: 'impl', to: 'rev', edges: [expect.objectContaining({ id: 'handover' }), expect.objectContaining({ id: 'review' })] },
      { id: 'verdict', from: 'rev', to: 'merge', edges: [expect.objectContaining({ id: 'verdict' })] },
    ]);
  });

  it('keeps every edge between the same two agents on their one rail, whichever sides they were drawn from', () => {
    const rails = railsOf([handover({ fromSide: 'bottom', toSide: 'top' }), review(), edge('again', 'impl', 'rev', { createdAt: at(14, 2) })]);

    expect(rails.map((rail) => rail.edges.map((each) => each.id))).toEqual([['handover', 'review', 'again']]);
  });
});

describe('railOf', () => {
  it('finds the rail an edge is on, from either of its edges', () => {
    const edges = [handover(), edge('verdict', 'rev', 'merge'), review()];

    expect(railOf(edges, edges[2]!)).toMatchObject({ id: 'handover', from: 'impl', edges: [{ id: 'handover' }, { id: 'review' }] });
  });
});

describe('railToken', () => {
  it('rests at the end of whoever was last delivered to, saying when, with its round', () => {
    const rail = pair(handover(delivered(at(14, 2))), review(delivered(at(14, 31))));

    expect(token(rail)).toEqual({ edge: expect.objectContaining({ id: 'review' }), state: 'delivered', end: 'to', round: 1, note: 'delivered 14:31' });
  });

  it('counts its round by how many times that edge has delivered', () => {
    const rail = pair(handover(delivered(at(14, 40), 2)), review(delivered(at(14, 31))));

    expect(token(rail)).toMatchObject({ edge: { id: 'handover' }, end: 'to', round: 2 });
  });

  it('waits at the sender for Send once a manual edge’s agent has finished a turn since the edge last delivered: its next round', () => {
    const rail = pair(handover(delivered(at(14, 40), 2)), review(delivered(at(14, 31))));

    expect(token(rail, { ready: { rev: at(14, 45) } })).toEqual({ edge: expect.objectContaining({ id: 'review' }), state: 'waiting', end: 'from', round: 2 });
  });

  it('does not wait while that agent is still at work, nor once it has sent what its last turn left', () => {
    const working = pair(handover(delivered(at(14, 40), 2)), review(delivered(at(14, 31))));
    const sent = pair(handover(delivered(at(14, 2))), review(delivered(at(14, 31))));

    expect(token(working)).toMatchObject({ state: 'delivered', edge: { id: 'handover' } });
    expect(token(sent, { ready: { rev: at(14, 20) } })).toMatchObject({ state: 'delivered', edge: { id: 'review' } });
  });

  it('waits again on a one-way manual edge once its agent finishes another turn after it delivered', () => {
    const rail = pair(edge('verdict', 'rev', 'merge', { trigger: 'manual', ...delivered(at(14, 2)) }));

    expect(token(rail, { ready: { rev: at(14, 0) } })).toMatchObject({ state: 'delivered', end: 'to' });
    expect(token(rail, { ready: { rev: at(14, 30) } })).toMatchObject({ state: 'waiting', end: 'from' });
  });

  it("never waits on a one-off edge: its agent handed off along it mid-turn, so its turn ends after it delivered", () => {
    const rail = pair(edge('named', 'impl', 'rev', { trigger: 'manual', oneOff: true, madeBy: 'impl', ...delivered(at(14, 10)) }));

    expect(token(rail, { ready: { impl: at(14, 11) } })).toMatchObject({ state: 'delivered', end: 'to', note: 'delivered 14:10' });
  });

  it('waits on a pair’s manual edge whose agent worked again with nothing delivered to it, as when prompted by hand', () => {
    const rail = pair(handover({ trigger: 'manual', ...delivered(at(14, 2)) }), review());

    expect(token(rail, { ready: { impl: at(14, 20) } })).toMatchObject({ edge: { id: 'handover' }, state: 'waiting', end: 'from', round: 2 });
  });

  it('waits on a one-way manual edge that has never delivered, its agent done', () => {
    const rail = pair(edge('verdict', 'rev', 'merge', { trigger: 'manual', path: 'verdict.json', payload: 'json' }));

    expect(token(rail, { ready: { rev: null } })).toEqual({ edge: expect.objectContaining({ id: 'verdict' }), state: 'waiting', end: 'from' });
  });

  it('slides to the receiver while a hand-off goes along an edge, ahead of anything else', () => {
    const rail = pair(handover({ ...delivered(at(14, 2)), delivering: true }), review(delivered(at(14, 31))));

    expect(token(rail, { live: ['handover'], ready: { rev: at(14, 45) } })).toEqual({ edge: expect.objectContaining({ id: 'handover' }), state: 'sending', end: 'to', round: 2, note: 'sending…' });
  });

  it('is held at the sender while a condition holds it, saying what for and how many of its conditions pass', () => {
    const rail = pair(
      handover({
        held: { since: at(14, 50), reason: 'CI is red', name: 'handover.md', copy: false },
        conditions: [{ kind: 'pr-checks' }, { kind: 'issue-label', label: 'ready' }],
        checks: [{ passed: false, at: '', detail: '' }, { passed: true, at: '', detail: '' }],
      }),
      review(delivered(at(14, 31))),
    );

    expect(token(rail)).toEqual({ edge: expect.objectContaining({ id: 'handover' }), state: 'held', end: 'from', round: 1, note: 'held until CI green', passing: '1/2' });
  });

  it('queues at the sender until the receiver can take it, and says a skipped delivery failed', () => {
    const queued = pair(handover({ queued: { since: at(14, 50), name: 'handover.md', copy: false } }));
    const skipped = pair(handover({ lastDelivery: { at: at(14, 50), delivered: false, reason: 'no handover.md' } }));

    expect(token(queued)).toMatchObject({ state: 'queued', end: 'from', note: 'queued' });
    expect(token(skipped)).toMatchObject({ state: 'failed', end: 'from', note: 'skipped' });
  });

  it('shows what comes next on an edge that has carried nothing yet, as a ghost at the sender', () => {
    expect(token(pair(edge('verdict', 'rev', 'merge')))).toMatchObject({ state: 'next', end: 'from', note: 'when done' });
    expect(token(pair(edge('verdict', 'rev', 'merge', { trigger: 'manual' })))).toMatchObject({ state: 'next', note: 'on send' });
    expect(token(pair(edge('verdict', 'rev', 'merge', { conditions: [{ kind: 'pr-checks' }] })))).toMatchObject({ state: 'next', note: 'on CI green' });
  });

  it('says a paused edge is paused, where it rests', () => {
    const rail = pair(handover({ ...delivered(at(14, 2)), paused: true }));

    expect(token(rail, { ready: { impl: at(14, 30) } })).toMatchObject({ state: 'delivered', end: 'to', note: 'paused' });
  });

  it('says a paused edge is paused while it holds or queues a hand-off too, and what for', () => {
    const held = pair(handover({ paused: true, held: { since: at(14, 50), reason: 'CI is red', name: 'handover.md', copy: false }, conditions: [{ kind: 'pr-checks' }], checks: [{ passed: false, at: '', detail: '' }] }));
    const queued = pair(handover({ paused: true, queued: { since: at(14, 50), name: 'handover.md', copy: false } }));

    expect(token(held)).toMatchObject({ state: 'held', end: 'from', note: 'paused · held until CI green' });
    expect(token(queued)).toMatchObject({ state: 'queued', end: 'from', note: 'paused · queued' });
  });
});

describe('withRailSelected', () => {
  it("selects the token's edge of a rail picked, or keeps the one of its edges already selected (the direction the Edge rules show)", () => {
    expect([...withRailSelected(new Set(['other']), ['handover', 'review'], true, 'review')]).toEqual(['other', 'review']);
    expect([...withRailSelected(new Set(['handover']), ['handover', 'review'], true, 'review')]).toEqual(['handover']);
  });

  it('unselects every edge of a rail unselected', () => {
    expect([...withRailSelected(new Set(['handover', 'review', 'other']), ['handover', 'review'], false, 'review')]).toEqual(['other']);
  });
});

describe('tokenSlots', () => {
  const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
    lead: { x: 0, y: 200, width: 280, height: 160 },
    one: { x: 600, y: 0, width: 280, height: 160 },
    two: { x: 600, y: 200, width: 280, height: 160 },
    three: { x: 600, y: 400, width: 280, height: 160 },
    below: { x: 0, y: 700, width: 280, height: 160 },
  };
  const slots = (edges: FlowEdge[]) => {
    const rails = railsOf(edges);
    return tokenSlots(
      rails.map((rail) => ({ rail, token: token(rail) })),
      (sessionId) => rects[sessionId],
    );
  };

  it('spreads the tokens off one side of a tile, in the order of the tiles their rails go to, so none lies on another', () => {
    // An orchestrator fanning out to three workers to its right: three ghosts off its right side.
    const fanned = slots([edge('to-three', 'lead', 'three'), edge('to-one', 'lead', 'one'), edge('to-two', 'lead', 'two')]);

    expect(fanned).toEqual(
      new Map([
        ['to-one', { index: 0, count: 3 }],
        ['to-two', { index: 1, count: 3 }],
        ['to-three', { index: 2, count: 3 }],
      ]),
    );
  });

  it('counts only the tokens at the same side of the same tile', () => {
    // One rail leaves the lead's right side, the other its bottom; a token delivered to the lead from its right sits
    // there beside the first, and one delivered to another tile is that tile's.
    const apart = slots([
      edge('right', 'lead', 'two'),
      edge('down', 'lead', 'below'),
      edge('back', 'three', 'lead', { ...delivered(at(14, 2)), createdAt: at(13, 0) }),
      edge('sent', 'one', 'two', { ...delivered(at(14, 2)), createdAt: at(13, 1) }),
    ]);

    expect(apart).toEqual(
      new Map([
        ['back', { index: 1, count: 2 }],
        ['sent', { index: 0, count: 1 }],
        ['right', { index: 0, count: 2 }],
        ['down', { index: 0, count: 1 }],
      ]),
    );
  });
});

describe('moving an end of a rail onto another agent', () => {
  const shape = { fromSide: 'right' as const, toSide: 'top' as const, points: [{ x: 0, y: 40 }] };

  it('moves the one edge of a one-way rail, in the shape it was dragged to', () => {
    expect(railMoved(pair(handover()), 'to', 'checker', shape)).toEqual([['handover', { to: 'checker', ...shape }]]);
    expect(railMoved(pair(handover()), 'from', 'planner', shape)).toEqual([['handover', { from: 'planner', ...shape }]]);
  });

  it("moves both edges of a linked pair, the rail's shape kept on the edge made first", () => {
    const rail = pair(handover(), review());
    expect(railMoved(rail, 'to', 'checker', shape)).toEqual([
      ['handover', { to: 'checker', ...shape }],
      ['review', { from: 'checker' }],
    ]);
  });
});

describe('whether a rail can move its end onto an agent', () => {
  const linked = () => [handover(), review()];

  it('can onto an agent its edges would join no other edge the same way', () => {
    expect(railMoveRefused(pair(...linked()), 'to', 'checker', linked())).toBeUndefined();
  });

  it("can't onto the agent at its other end", () => {
    expect(railMoveRefused(pair(handover()), 'to', 'impl', [handover()])).toBeDefined();
  });

  it("can't when one of its edges would join a pair already joined that way: a linked pair would split into two rails", () => {
    const back = edge('back', 'checker', 'impl', { trigger: 'manual' });
    expect(railMoveRefused(pair(...linked()), 'to', 'checker', [...linked(), back])).toBeDefined();
    // One way only, the edge back from the new agent is no collision: they become a linked pair.
    expect(railMoveRefused(pair(handover()), 'to', 'checker', [handover(), back])).toBeUndefined();
  });

  it("can't when an auto edge would close a loop of auto edges", () => {
    const back = edge('back', 'checker', 'impl');
    expect(railMoveRefused(pair(handover()), 'to', 'checker', [handover(), back])).toBeDefined();
  });
});
