import { useState } from 'react';
import { MiniMap, useReactFlow, useStore, type Node } from '@xyflow/react';
import { Grid3x3, Map as MapIcon, Minus, Plus } from 'lucide-react';
import { Button, Island, IslandSeparator, ToolButton } from '../ui';
import { ViewPopover, type ViewPopoverProps } from './ViewPopover';

/**
 * The bottom-right island (chrome C): zoom out, the zoom (a click fits the board), zoom in, snapping to the grid, and
 * the minimap's toggle, with the minimap over it. The View button opens the popover of view settings.
 */
export function ZoomControls({
  nodeColor,
  grid,
  onGrid,
  ...view
}: { nodeColor(node: Node): string; grid: boolean; onGrid(): void } & ViewPopoverProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const [minimap, setMinimap] = useState(true);
  return (
    <>
      {minimap && <MiniMap className="board-minimap" pannable zoomable nodeColor={nodeColor} nodeStrokeColor="var(--raised-edge)" ariaLabel="Minimap" />}
      <Island className="zoom-controls island-bottom-right" role="group" aria-label="Zoom">
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
        <ViewPopover {...view} />
        <ToolButton size="sm" icon={<Grid3x3 />} label="Snap to grid" hint={grid ? 'Stop snapping to the grid' : 'Snap what you drag to the grid'} pressed={grid} onClick={onGrid} />
        <ToolButton size="sm" icon={<MapIcon />} label="Minimap" hint={minimap ? 'Hide the minimap' : 'Show the minimap'} pressed={minimap} onClick={() => setMinimap(!minimap)} />
      </Island>
    </>
  );
}
