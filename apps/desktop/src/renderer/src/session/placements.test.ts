import { describe, expect, it } from 'vitest';
import type { Shell } from '@agent-board/daemon/protocol';
import { placeSurface, singlePane } from '@agent-board/daemon/window-layout';
import { arrivalPlacement, expectArrival, noteDepartures, settleArrival } from './placements';

const shell = (id: string, sessionId: string) => ({ id, layout: { type: 'pane', sessionId } }) as Shell;
const agentA = { kind: 'agent', id: 'a' } as const;
const agentB = { kind: 'agent', id: 'b' } as const;

describe('where a tab lands in a window', () => {
  it('goes where it was dropped, by its shell or the pane it was moved out of, in that window only, until laid out', () => {
    expectArrival('x', agentA, { pane: 'main', edge: 'right' });
    expectArrival('p9', agentA, { pane: 'p2' });

    expect(arrivalPlacement(agentB, shell('x', 'p1'))).toBeUndefined();
    expect(arrivalPlacement(agentA, shell('x', 'p1'))).toEqual({ pane: 'main', edge: 'right' });
    expect(arrivalPlacement(agentA, shell('x', 'p1'))).toEqual({ pane: 'main', edge: 'right' });
    expect(arrivalPlacement(agentA, shell('new', 'p9'))).toEqual({ pane: 'p2' });
    settleArrival(agentA, shell('x', 'p1'));
    settleArrival(agentA, shell('new', 'p9'));
    expect(arrivalPlacement(agentA, shell('x', 'p1'))).toBeUndefined();
    expect(arrivalPlacement(agentA, shell('new', 'p9'))).toBeUndefined();
  });

  it('goes back where it was in a window it left, as an undo brings it back', () => {
    let n = 0;
    const before = placeSurface(singlePane([{ kind: 'own' }, { kind: 'shell', shellId: 'y' }, { kind: 'shell', shellId: 'z' }]), { kind: 'shell', shellId: 'z' }, { pane: 'main', edge: 'bottom' }, () => `id${++n}`);
    noteDepartures(agentB, before, singlePane([{ kind: 'own' }]));

    expect(arrivalPlacement(agentB, shell('y', 'p1'))).toEqual({ pane: 'main', index: 1 });
    expect(arrivalPlacement(agentB, shell('z', 'p2'))).toEqual({ pane: 'id1', index: 0 });
    expect(arrivalPlacement(agentA, shell('y', 'p1'))).toBeUndefined();
    settleArrival(agentB, shell('y', 'p1'));
    expect(arrivalPlacement(agentB, shell('y', 'p1'))).toBeUndefined();
  });
});
