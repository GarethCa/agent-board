import { MiniMap, MiniMapNode, useReactFlow, useStore, type MiniMapNodeProps, type Node } from '@xyflow/react';
import { Grid3x3, Map as MapIcon, Minus, Plus } from 'lucide-react';
import { useSimplified } from '../design';
import { useMenuBarAction } from '../keys/menu-bar-bridge';
import { Button, Island, IslandSeparator, ToolButton } from '../ui';
import { useMinimapShown } from './minimap-shown';
import { UsagePill } from './UsagePill';
import { useUsageOnBoard } from './usage-on-board';
import { ViewPopover, type ViewPopoverProps } from './ViewPopover';

/**
 * The bottom-right island (chrome C): zoom out, the zoom (a click fits the board), zoom in, snapping to the grid, and
 * the minimap's toggle, with the minimap over it, and the usage pill first when Settings › Usage shows it here. The View button opens the popover of view settings.
 * Under the Simplified design the grid and the minimap move into the View menu, the minimap is off until turned on, and the usage goes to the top right, before Needs you.
 */
export function ZoomControls({
  nodeColor,
  nodeMarked,
  grid,
  onGrid,
  ...view
}: {
  nodeColor(node: Node): string;
  /** Whether a node carries the minimap's mark of a tile with its own board inside (a ticket's). */
  nodeMarked?(node: Node): boolean;
  grid: boolean;
  onGrid(): void;
} & ViewPopoverProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const simplified = useSimplified();
  // Shown by default under Classic and hidden under the Simplified design, until it is turned on or off here.
  const [minimap, setMinimap] = useMinimapShown();
  const [usageOnBoard] = useUsageOnBoard();
  // View's zoom, snapping and minimap items do what these do.
  useMenuBarAction('zoomIn', () => void zoomIn());
  useMenuBarAction('zoomOut', () => void zoomOut());
  useMenuBarAction('zoomToFit', () => void fitView({ maxZoom: 1 }));
  useMenuBarAction('snapToGrid', onGrid, grid);
  useMenuBarAction('minimap', () => setMinimap(!minimap), minimap);
  useMenuBarAction('tethers', () => view.onTethers(!view.tethers), view.tethers);
  return (
    <>
      {minimap && (
        <BoardMinimap nodeColor={nodeColor} nodeMarked={nodeMarked} label="Minimap" />
      )}
      <Island className="zoom-controls island-bottom-right" role="group" aria-label="Zoom">
        {usageOnBoard && !simplified && <UsagePill separated />}
        <ToolButton size="sm" icon={<Minus />} label="Zoom out" onClick={() => void zoomOut()} />
        <Button
          size="sm"
          variant="ghost"
          className="zoom-level"
          aria-label={`Fit view (${Math.round(zoom * 100)}%)`}
          tooltip="Fit the board in view"
          onClick={() => void fitView({ maxZoom: 1 })}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <ToolButton size="sm" icon={<Plus />} label="Zoom in" onClick={() => void zoomIn()} />
        <IslandSeparator />
        {simplified ? (
          <ViewPopover {...view} toggles={{ grid, onGrid, minimap, onMinimap: () => setMinimap(!minimap) }} />
        ) : (
          <>
            <ViewPopover {...view} />
            <ToolButton size="sm" icon={<Grid3x3 />} label="Snap to grid" hint={grid ? 'Stop snapping to the grid' : 'Snap what you drag to the grid'} pressed={grid} onClick={onGrid} />
            <ToolButton size="sm" icon={<MapIcon />} label="Minimap" hint={minimap ? 'Hide the minimap' : 'Show the minimap'} pressed={minimap} onClick={() => setMinimap(!minimap)} />
          </>
        )}
      </Island>
    </>
  );
}

/**
 * A board's minimap, the same on every level: the main board's and each ticket's own. Its colours come from the theme
 * variables `.board` and `.ticket-board` set.
 */
export function BoardMinimap({ nodeColor, nodeMarked, label }: { nodeColor(node: Node): string; nodeMarked?(node: Node): boolean; label: string }) {
  return (
    <MiniMap
      className="board-minimap"
      pannable
      zoomable
      nodeColor={nodeColor}
      nodeStrokeColor="var(--raised-edge)"
      nodeClassName={(node) => (nodeMarked?.(node) === true ? MARKED : '')}
      nodeComponent={MarkedNode}
      ariaLabel={label}
    />
  );
}

/** The class of a node on the minimap that carries the mark of its own board inside. */
const MARKED = 'board-minimap-marked';

/** A node on the minimap: its box, and for a tile with its own board inside, a small board in its top-right corner. */
function MarkedNode(props: MiniMapNodeProps) {
  if (!props.className.split(' ').includes(MARKED)) return <MiniMapNode {...props} />;
  const { x, y, width, height } = props;
  const side = Math.min(width, height) * MARK_SHARE;
  const inset = side / 3;
  return (
    <g data-testid="minimap-ticket-mark">
      <MiniMapNode {...props} />
      <rect className="board-minimap-mark" x={x + width - side - inset} y={y + inset} width={side} height={side} rx={side / 4} ry={side / 4} />
    </g>
  );
}

/** How big the mark is, as a share of the node's shorter side. */
const MARK_SHARE = 0.4;
