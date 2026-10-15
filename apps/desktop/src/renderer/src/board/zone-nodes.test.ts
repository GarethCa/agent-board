import { describe, expect, it } from 'vitest';
import type { Zone } from '@agent-board/daemon/protocol';
import { withZone, withoutZone } from './zone-nodes';
import { zoneNode } from './ZoneNode';

const zone = (id: string, overrides: Partial<Zone> = {}): Zone => ({
  id,
  kind: 'unbound',
  repoRoot: null,
  folder: '',
  name: id,
  color: '#4c6ef5',
  fillOpacity: null,
  x: 0,
  y: 0,
  width: 720,
  height: 480,
  codexBypassHookTrust: true,
  boardMcp: true,
  agentsOrchestrate: false,
  gateCommand: null,
  tracker: null,
  clone: null,
  managedClone: false,
  defaultRepo: null,
  createdAt: '',
  ...overrides,
});

describe('withZone', () => {
  it('adds a new zone first, under everything else', () => {
    const nodes = withZone([{ id: 'item:a', position: { x: 0, y: 0 }, data: {} }], zone('z1'));
    expect(nodes.map((node) => node.id)).toEqual(['z1', 'item:a']);
  });

  it("updates a known zone's data and layout, keeping what was added to its node", () => {
    const known = { ...zoneNode(zone('z1')), selected: true, data: { zone: zone('z1'), tileCount: 3 } };
    const [node] = withZone([known], zone('z1', { name: 'Renamed', x: 50, width: 800 })) as (typeof known)[];
    expect(node).toMatchObject({ selected: true, position: { x: 50, y: 0 }, width: 800, data: { tileCount: 3, zone: { name: 'Renamed' } } });
  });

  it('keeps the place and size of a zone being dragged or resized', () => {
    const known = { ...zoneNode(zone('z1')), dragging: true, position: { x: 99, y: 99 } };
    const [node] = withZone([known], zone('z1', { x: 50, clone: { repo: 'acme/app', path: '/r', phase: null, percent: 10 } }));
    expect(node).toMatchObject({ position: { x: 99, y: 99 }, data: { zone: { clone: { percent: 10 } } } });
  });
});

describe('withoutZone', () => {
  it('drops the zone and the items drawn in it', () => {
    const nodes = [zoneNode(zone('z1')), { id: 'item:a', parentId: 'z1', position: { x: 0, y: 0 }, data: {} }, zoneNode(zone('z2'))];
    expect(withoutZone(nodes, 'z1').map((node) => node.id)).toEqual(['z2']);
  });
});
