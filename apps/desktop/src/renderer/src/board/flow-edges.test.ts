import { describe, expect, it } from 'vitest';
import type { FlowEdge } from '@agent-board/daemon/protocol';
import { AGENT_NODE_PREFIX } from './tiles';
import {
  conditionName,
  edgeLabel,
  edgeTitle,
  FLOW_EDGE_TYPE,
  flowEdgeIdOf,
  flowEdgeIdsOf,
  flowEdges,
  handoffEnds,
  deliveredLabel,
  heldLabel,
  historyLine,
  isFlowEdge,
  liveHandoffs,
  panClear,
  rulesSummary,
  withFlowEdgeChange,
  withChanges,
  withChangesUndone,
} from './flow-edges';

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
  fromSide: 'right',
  toSide: 'left',
  style: 'curved',
  points: [],
  createdAt: '',
  updatedAt: '',
  ...overrides,
});
const AUTO = { fromSide: 'auto', toSide: 'auto' } as const;
const tileId = (sessionId: string) => `${AGENT_NODE_PREFIX}${sessionId}`;

describe('flowEdges', () => {
  it("draws each rail from the side of its first edge's agent's tile it leaves to the side of the other's it arrives at, selected or not, live or not", () => {
    const drawn = flowEdges(
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c', { fromSide: 'bottom', toSide: 'top' })],
      new Set([tileId('a'), tileId('b'), tileId('c')]),
      new Set(['e2']),
      { live: new Set(['e2']) },
    );

    expect(drawn).toEqual([
      expect.objectContaining({
        type: FLOW_EDGE_TYPE,
        source: tileId('a'),
        sourceHandle: 'right',
        target: tileId('b'),
        targetHandle: 'left',
        selected: false,
        data: expect.objectContaining({ rail: expect.objectContaining({ id: 'e1' }), token: expect.objectContaining({ state: 'next' }), live: false }),
      }),
      expect.objectContaining({ sourceHandle: 'bottom', targetHandle: 'top', selected: true, data: expect.objectContaining({ live: true }) }),
    ]);
    expect(drawn.every(isFlowEdge)).toBe(true);
    expect(drawn.map(flowEdgeIdsOf)).toEqual([['e1'], ['e2']]);
  });

  it('draws two agents joined both ways as one rail, selected while either of its edges is, its token the latest document', () => {
    const drawn = flowEdges(
      [edge('e1', 'a', 'b', AUTO), edge('e2', 'b', 'a', { ...AUTO, lastDelivery: { at: '2026-10-15T14:31:00.000Z', delivered: true, reason: null }, deliveries: 1 })],
      new Set([tileId('a'), tileId('b')]),
      new Set(['e2']),
    );

    expect(drawn).toEqual([
      expect.objectContaining({ source: tileId('a'), target: tileId('b'), selected: true, data: expect.objectContaining({ token: expect.objectContaining({ state: 'delivered', end: 'to' }) }) }),
    ]);
    expect(drawn.map(flowEdgeIdsOf)).toEqual([['e1', 'e2']]);
    expect(drawn.map(flowEdgeIdOf)).toEqual(['e1']);
    expect(drawn[0]!.data!.token.edge.id).toBe('e2');
  });

  it("keeps edge ids whole, whatever they hold: a rail is drawn under its first edge's id, and knows its edges by its data", () => {
    const drawn = flowEdges([edge('a,1', 'a', 'b'), edge('b,2', 'b', 'a')], new Set([tileId('a'), tileId('b')]), new Set());

    expect(drawn.map(flowEdgeIdOf)).toEqual(['a,1']);
    expect(drawn.map(flowEdgeIdsOf)).toEqual([['a,1', 'b,2']]);
  });

  it("shows a manual edge that has never delivered waiting for Send once its agent is done with its turn", () => {
    const [drawn] = flowEdges([edge('e1', 'a', 'b', { trigger: 'manual' })], new Set([tileId('a'), tileId('b')]), new Set(), { ready: new Map([['a', null]]) });

    expect(drawn!.data!.token).toMatchObject({ state: 'waiting', end: 'from' });
  });

  it('leaves out an edge whose agent is not on the board, as when it was deleted', () => {
    expect(flowEdges([edge('e1', 'a', 'gone')], new Set([tileId('a')]), new Set())).toEqual([]);
  });
});

describe('withFlowEdgeChange', () => {
  it('adds a new edge, replaces a changed one and drops a removed one', () => {
    const first = edge('e1', 'a', 'b');
    const added = withFlowEdgeChange([], { type: 'flowEdge.updated', edge: first });
    const changed = withFlowEdgeChange(added, { type: 'flowEdge.updated', edge: { ...first, trigger: 'manual' } });

    expect(added).toEqual([first]);
    expect(changed).toEqual([{ ...first, trigger: 'manual' }]);
    expect(withFlowEdgeChange(changed, { type: 'flowEdge.removed', id: 'e1' })).toEqual([]);
  });
});

describe('liveHandoffs', () => {
  it('shows a delivering edge live, and holds it so for `hold` ms from when it started, however soon it finished', () => {
    const going = liveHandoffs([edge('e1', 'a', 'b', { delivering: true }), edge('e2', 'b', 'c')], new Map(), 1000, 1600);
    expect(going).toEqual({ live: new Set(['e1']), since: new Map([['e1', 1000]]), wakeIn: undefined });

    const done = liveHandoffs([edge('e1', 'a', 'b'), edge('e2', 'b', 'c')], going.since, 1100, 1600);
    expect(done).toEqual({ live: new Set(['e1']), since: new Map([['e1', 1000]]), wakeIn: 1500 });

    expect(liveHandoffs([edge('e1', 'a', 'b')], done.since, 2600, 1600)).toEqual({ live: new Set(), since: new Map(), wakeIn: undefined });
  });

  it("doesn't hold a delivery that was skipped", () => {
    const skipped = { at: '', delivered: false, reason: 'it was still working' };
    expect(liveHandoffs([edge('e1', 'a', 'b', { lastDelivery: skipped })], new Map([['e1', 1000]]), 1100, 1600)).toEqual({
      live: new Set(),
      since: new Map(),
      wakeIn: undefined,
    });
  });

  it('keeps a slow delivery live past `hold`, and forgets an edge that has gone', () => {
    const since = new Map([['e1', 0], ['gone', 0]]);
    expect(liveHandoffs([edge('e1', 'a', 'b', { delivering: true })], since, 5000, 1600)).toEqual({ live: new Set(['e1']), since: new Map([['e1', 0]]), wakeIn: undefined });
  });
});

describe('handoffEnds', () => {
  it('names the agents sending and receiving along the live edges', () => {
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')];
    expect(handoffEnds(edges, new Set(['e1', 'e3']))).toEqual({ sending: new Set(['a', 'c']), receiving: new Set(['b', 'd']) });
  });
});

describe('edgeLabel', () => {
  it('names what the edge carries: its final message, or its file by its own name', () => {
    expect(edgeLabel(edge('e', 'a', 'b'))).toBe('final message');
    expect(edgeLabel(edge('e', 'a', 'b', { payload: 'handover', path: 'docs/plan.md' }))).toBe('plan.md');
    expect(edgeLabel(edge('e', 'a', 'b', { payload: 'json', path: 'handoff.json' }))).toBe('handoff.json');
    // As Windows spells a path.
    expect(edgeLabel(edge('e', 'a', 'b', { payload: 'handover', path: 'docs\\plan.md' }))).toBe('plan.md');
  });

  it('shortens a long file name to fit the label, keeping its extension', () => {
    expect(edgeLabel(edge('e', 'a', 'b', { payload: 'handover', path: 'a-very-long-handover-name.md' }))).toBe('a-very-long….md');
  });
});

describe('conditionName', () => {
  it('says each condition as the Edge rules list it', () => {
    expect(conditionName({ kind: 'gate-green', command: 'pnpm check:local' })).toBe('Only if gate green');
    expect(conditionName({ kind: 'pr-checks' })).toBe('Only if PR checks pass');
    expect(conditionName({ kind: 'issue-label', label: 'ready-for-agent' })).toBe('Issue has label ready-for-agent');
    expect(conditionName({ kind: 'script', command: './ready.sh' })).toBe('Script passes: ./ready.sh');
  });
});

describe('heldLabel', () => {
  it('says what a held hand-off waits for: the first condition that failed', () => {
    const held = edge('e', 'a', 'b', {
      conditions: [{ kind: 'gate-green', command: 'x' }, { kind: 'pr-checks' }],
      checks: [
        { passed: true, at: '', detail: 'green' },
        { passed: false, at: '', detail: 'PR #214 checks pending' },
      ],
      held: { since: '', reason: 'PR #214 checks pending', name: 'final message', copy: true },
    });
    expect(heldLabel(held)).toBe('held until CI green');
    expect(
      heldLabel({ ...held, checks: [{ passed: false, at: '', detail: 'waiting for your approval', needsApproval: true }, null] }),
    ).toBe('held until you approve');
    expect(heldLabel({ ...held, held: null })).toBeUndefined();
    // Not checked again since a restart: what the daemon kept of why.
    expect(heldLabel({ ...held, checks: [null, null] })).toBe('held: PR #214 checks pending');
  });
});

describe('historyLine', () => {
  it('says what happened along the edge', () => {
    expect(historyLine({ at: '', kind: 'delivered', detail: 'plan.md (2.1 KB)' }, 'movable-sessions')).toBe(
      'Sent plan.md (2.1 KB) to movable-sessions',
    );
    expect(historyLine({ at: '', kind: 'skipped', detail: 'it was still working' }, 'B')).toBe('Skipped: it was still working');
    expect(historyLine({ at: '', kind: 'held', detail: 'PR #214 checks pending' }, 'B')).toBe('Held: PR #214 checks pending');
    expect(historyLine({ at: '', kind: 'released', detail: 'every condition passed' }, 'B')).toBe('Released: every condition passed');
    expect(historyLine({ at: '', kind: 'approved', detail: 'pnpm check:local' }, 'B')).toBe('Approved: pnpm check:local');
    expect(historyLine({ at: '', kind: 'queued', detail: 'it was still working' }, 'B')).toBe("Queued until B's turn ends: it was still working");
  });
});

describe('panClear', () => {
  it('pans the board left just enough for both ends to clear the panel', () => {
    expect(panClear({ left: 400, right: 1300 }, 1100, 24)).toBe(224);
  });

  it("doesn't pan when they are clear already", () => {
    expect(panClear({ left: 100, right: 900 }, 1100, 24)).toBe(0);
  });

  it('never pans the left end out of view: as far as it can', () => {
    expect(panClear({ left: 100, right: 1300 }, 1100, 24)).toBe(76);
  });
});

describe('withChanges and withChangesUndone', () => {
  it('applies a change of payload at once, with its default file, and puts back only what it changed', () => {
    const was = edge('e', 'a', 'b');
    const changed = withChanges(was, { payload: 'handover', paused: true });
    expect(changed).toMatchObject({ payload: 'handover', path: 'handover.md', paused: true });

    // Refused, while a delivery was heard of: that stays.
    const heard = { ...changed, deliveries: 2, history: [{ at: 't', kind: 'delivered' as const, detail: 'x' }] };
    expect(withChangesUndone(heard, was, { payload: 'handover', paused: true })).toEqual({ ...was, deliveries: 2, history: heard.history });
  });

  it('reshapes it at once, its rules as they were', () => {
    const was = edge('e', 'a', 'b');
    const shape = { fromSide: 'bottom' as const, toSide: 'top' as const, style: 'elbow' as const, points: [{ x: 10, y: 20 }] };
    expect(withChanges(was, shape)).toEqual({ ...was, ...shape });
    expect(withChangesUndone(withChanges(was, shape), was, shape)).toEqual(was);
  });
});

describe('deliveredLabel', () => {
  const now = new Date(2026, 9, 13, 15, 0);
  const at = new Date(2026, 9, 13, 14, 2).toISOString();

  it('says when the edge last delivered, by its local time', () => {
    expect(deliveredLabel(edge('e', 'a', 'b', { lastDelivery: { at, delivered: true, reason: null } }), now)).toBe('delivered 14:02');
  });

  it('says nothing before its first delivery, or after a skipped one', () => {
    expect(deliveredLabel(edge('e', 'a', 'b'), now)).toBeUndefined();
    expect(deliveredLabel(edge('e', 'a', 'b', { lastDelivery: { at, delivered: false, reason: 'B was busy' } }), now)).toBeUndefined();
  });
});

describe('edgeTitle', () => {
  it('says who made an edge an agent made, and why its last delivery was skipped', () => {
    const skipped = { lastDelivery: { at: '', delivered: false, reason: 'B was busy' } };
    expect(edgeTitle(edge('e', 'a', 'b'), 'lead')).toBeUndefined();
    expect(edgeTitle(edge('e', 'a', 'b', { madeBy: 'o' }), 'lead')).toBe('Made by lead, an orchestrator');
    expect(edgeTitle(edge('e', 'a', 'b', { madeBy: 'o', ...skipped }), undefined)).toBe('Made by an orchestrator since deleted\nLast delivery skipped: B was busy');
    // A named hand-off's one-off edge.
    expect(edgeTitle(edge('e', 'a', 'b', { madeBy: 'a', oneOff: true }), 'impl')).toBe('A one-off hand-off from impl');
    expect(edgeTitle(edge('e', 'a', 'b', skipped), undefined)).toBe('Last delivery skipped: B was busy');
  });
});

describe('rulesSummary', () => {
  const names = { from: 'Fix flake', to: 'Review fix' };

  it("says, in a line each, when the edge sends, what, and what it waits for (BQ3)", () => {
    expect(rulesSummary(edge('e', 'a', 'b'), names)).toEqual({
      when: 'Sends by itself when Fix flake hands off',
      what: "Sends Fix flake's final message",
      onlyIf: 'Nothing to wait for',
    });
  });

  it('names a manual trigger, a file and its conditions, and what a hand-off it holds waits for', () => {
    const manual = edge('e', 'a', 'b', { trigger: 'manual', payload: 'handover', path: 'notes/handover.md', conditions: [{ kind: 'pr-checks' }] });
    expect(rulesSummary(manual, names)).toEqual({
      when: 'Sends when you press Send',
      what: 'Sends notes/handover.md from its worktree',
      onlyIf: 'Waits until CI green',
    });
    const held = { ...manual, payload: 'json' as const, path: 'out.json', held: { since: 't', reason: 'checks running', name: 'out.json', copy: true } };
    held.checks = [{ at: 't', passed: false, detail: '2 of 3 running' }];
    expect(rulesSummary(held, names)).toMatchObject({ what: 'Sends out.json as JSON from its worktree', onlyIf: 'Held until CI green' });
  });
});
