import { useState } from 'react';
import { MiniMap, useReactFlow, useStore, type Node } from '@xyflow/react';
import { Grid3x3, Map as MapIcon, Minus, Plus } from 'lucide-react';
import { useSimplified } from '../design';
import { Button, Island, IslandSeparator, ToolButton } from '../ui';
import { UsagePill } from './UsagePill';
import { useUsageOnBoard } from './usage-on-board';
import { ViewPopover, type ViewPopoverProps } from './ViewPopover';

/**
 * The bottom-right island (chrome C): zoom out, the zoom (a click fits the board), zoom in, snapping to the grid, and
 * the minimap's toggle, with the minimap over it, and the usage pill first when Settings › Usage shows it here. The View button opens the popover of view settings.
 * Under the Simplified design the grid and the minimap move into the View menu, and the minimap is off until turned on.
 */
export function ZoomControls({
  nodeColor,
  grid,
  onGrid,
  ...view
}: { nodeColor(node: Node): string; grid: boolean; onGrid(): void } & ViewPopoverProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const simplified = useSimplified();
  // Shown by default under Classic and hidden under the Simplified design, until it is turned on or off here.
  const [picked, setMinimap] = useState<boolean>();
  const minimap = picked ?? !simplified;
  const [usageOnBoard] = useUsageOnBoard();
  return (
    <>
      {minimap && <MiniMap className="board-minimap" pannable zoomable nodeColor={nodeColor} nodeStrokeColor="var(--raised-edge)" ariaLabel="Minimap" />}
      <Island className="zoom-controls island-bottom-right" role="group" aria-label="Zoom">
        {usageOnBoard && <UsagePill separated />}
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
