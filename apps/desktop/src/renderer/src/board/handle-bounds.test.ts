import { describe, expect, it } from 'vitest';
import type { InternalNode } from '@xyflow/react';
import { handlesLost } from './handle-bounds';

const node = (id: string, { measured = true, handles = true, hidden = false } = {}) =>
  ({
    id,
    position: { x: 0, y: 0 },
    data: {},
    hidden,
    measured: measured ? { width: 240, height: 112 } : {},
    internals: {
      positionAbsolute: { x: 0, y: 0 },
      z: 0,
      userNode: { id, position: { x: 0, y: 0 }, data: {} },
      handleBounds: handles ? { source: [], target: null } : undefined,
    },
  }) as unknown as InternalNode;

describe('handlesLost', () => {
  it('finds the nodes measured without their handles, which no edge can be drawn to', () => {
    const nodes = [node('fine'), node('lost', { handles: false }), node('also lost', { handles: false })];
    expect(handlesLost(nodes)).toEqual(['lost', 'also lost']);
  });

  it('leaves out a node not yet measured, which React Flow measures, handles and all, by itself', () => {
    expect(handlesLost([node('new', { measured: false, handles: false })])).toEqual([]);
  });

  it('leaves out a hidden node, which has no handles to measure', () => {
    expect(handlesLost([node('hidden', { handles: false, hidden: true })])).toEqual([]);
  });
});
