// A selected zone's lanes area, on shelves or in clusters: a dashed edge round the part of it they are laid out in, and a
// handle at each corner, inside the zone's own. Dragging one sizes the lanes area alone, its lanes reflowing as it goes;
// the rest of the zone is free, each tile there where it was put.
import { useContext, useEffect, useRef, type PointerEvent } from 'react';
import { useStore } from '@xyflow/react';
import type { ZoneLayout } from '@agent-board/daemon/protocol';
import { LANES_CORNERS, lanesDragged, type LanesCorner } from './lanes-area';
import { ZoneLanesContext } from './zone-contexts';

type Size = { width: number; height: number };

const TITLES: Record<LanesCorner, string> = {
  'top-left': 'Size the lanes area from its top left corner',
  'top-right': 'Size the lanes area from its top right corner',
  'bottom-left': 'Size the lanes area from its bottom left corner',
  'bottom-right': 'Size the lanes area from its bottom right corner',
};

interface Drag {
  corner: LanesCorner;
  from: { x: number; y: number };
  start: ZoneLayout;
  now: ZoneLayout;
}

export function LanesArea({ zoneId, lanes, zone }: { zoneId: string; lanes: { area: ZoneLayout; fits: Size }; zone: Size }) {
  const { draft, save } = useContext(ZoneLanesContext);
  const zoom = useStore((state) => state.transform[2]);
  const drag = useRef<Drag | null>(null);
  const { area } = lanes;
  // What its lanes need as last drawn: the draft's reflow can need more than they did as the drag began.
  const fits = useRef(lanes.fits);
  fits.current = lanes.fits;
  // Gone mid-drag (the zone deselected, say), it lets its draft go, so the zone is drawn at its saved lanes area again.
  useEffect(
    () => () => {
      if (drag.current !== null) draft(zoneId, null);
    },
    [draft, zoneId],
  );

  const down = (corner: LanesCorner) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The handle's own: it neither drags the zone nor starts a box selection.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { corner, from: { x: event.clientX, y: event.clientY }, start: area, now: area };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    if (now === null) return;
    const by = { x: (event.clientX - now.from.x) / zoom, y: (event.clientY - now.from.y) / zoom };
    now.now = lanesDragged(now.start, now.corner, by, zone, lanes.fits);
    draft(zoneId, now.now);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    if (now === null) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (now.now !== now.start) {
      // Never saved smaller than it is drawn, at what its reflowed lanes need.
      const least = fits.current;
      save(zoneId, { ...now.now, width: Math.min(Math.max(now.now.width, least.width), zone.width - now.now.x), height: Math.min(Math.max(now.now.height, least.height), zone.height - now.now.y) });
    }
    draft(zoneId, null);
  };

  return (
    <div
      className="zone-lanes-area"
      data-testid="zone-lanes-area"
      data-x={area.x}
      data-y={area.y}
      data-width={area.width}
      data-height={area.height}
      style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
    >
      {LANES_CORNERS.map((corner) => (
        <div
          key={corner}
          className="zone-lanes-handle nodrag nopan"
          data-testid="zone-lanes-handle"
          data-corner={corner}
          title={TITLES[corner]}
          onPointerDown={down(corner)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      ))}
    </div>
  );
}
