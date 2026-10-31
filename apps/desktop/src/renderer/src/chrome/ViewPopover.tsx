import { useState } from 'react';
import { ChevronDown, Eye } from 'lucide-react';
import type { ConnectionsView } from '../board/connections-view';
import type { CrewLook } from '../board/crew-view';
import { keyText } from '../keys/registry';
import { Button, Kbd, Popover, Segmented, Switch, ToolButton } from '../ui';

export interface ViewPopoverProps {
  connections: ConnectionsView;
  onConnections(value: ConnectionsView): void;
  crewLook: CrewLook;
  onCrewLook(value: CrewLook): void;
  /**
   * Snapping to the grid and the minimap, as switches in the popover: the Simplified design's, which has no buttons of
   * their own for them on the zoom bar. Classic leaves them out.
   */
  toggles?: { grid: boolean; onGrid(): void; minimap: boolean; onMinimap(): void };
}

/**
 * The zoom bar's View button: a popover with the two settings that only change how the board is drawn, which
 * connections it shows and how an orchestrator's crew is shown, so neither needs the Settings window. With `toggles`
 * it is the Simplified design's View menu: a labelled button, and the grid and minimap switches under the two.
 */
export function ViewPopover({ connections, onConnections, crewLook, onCrewLook, toggles }: ViewPopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      aria-label="View"
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      className="view-popover"
      content={
        <>
          <div className="view-row">
            <div className="view-label">
              Connections <Kbd>{keyText('move.connections')}</Kbd>
            </div>
            <Segmented
              aria-label="Connections"
              options={[
                { id: 'all', label: 'All' },
                { id: 'handoffs', label: 'Hand-offs' },
                { id: 'none', label: 'None' },
              ]}
              value={connections}
              onChange={onConnections}
            />
          </div>
          <div className="view-row">
            <div className="view-label">
              Crews <Kbd>{keyText('move.crews')}</Kbd>
            </div>
            <Segmented
              aria-label="Crews"
              options={[
                { id: 'frames', label: 'Frames' },
                { id: 'chips', label: 'Chips' },
                { id: 'off', label: 'Off' },
              ]}
              value={crewLook}
              onChange={onCrewLook}
            />
          </div>
          {toggles !== undefined && (
            <div className="view-switches">
              <Switch label="Snap to grid" checked={toggles.grid} onChange={toggles.onGrid} />
              <Switch label="Minimap" checked={toggles.minimap} onChange={toggles.onMinimap} />
            </div>
          )}
          <p className="view-foot">Only changes the view. More in Settings → Board.</p>
        </>
      }
    >
      {toggles !== undefined ? (
        <Button size="sm" variant="ghost" className="view-menu-button" trailingIcon={<ChevronDown aria-hidden />} aria-pressed={open} tooltip="What the board shows">
          View
        </Button>
      ) : (
        <ToolButton size="sm" className="view-button" icon={
            <>
              <Eye />
              <ChevronDown className="view-caret" aria-hidden />
            </>
          } label="View" hint="Which connections and crews the board shows" pressed={open} />
      )}
    </Popover>
  );
}
