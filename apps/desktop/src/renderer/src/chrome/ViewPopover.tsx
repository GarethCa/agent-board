import { useState } from 'react';
import { ChevronDown, Eye } from 'lucide-react';
import type { ConnectionsView } from '../board/connections-view';
import type { CrewLook } from '../board/crew-view';
import { keyText } from '../keys/registry';
import { Kbd, Popover, Segmented, ToolButton } from '../ui';

export interface ViewPopoverProps {
  connections: ConnectionsView;
  onConnections(value: ConnectionsView): void;
  crewLook: CrewLook;
  onCrewLook(value: CrewLook): void;
}

/**
 * The zoom bar's View button: a popover with the two settings that only change how the board is drawn, which
 * connections it shows and how an orchestrator's crew is shown, so neither needs the board menu's Settings.
 */
export function ViewPopover({ connections, onConnections, crewLook, onCrewLook }: ViewPopoverProps) {
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
          <p className="view-foot">Only changes the view. More in Settings → Board.</p>
        </>
      }
    >
      <ToolButton size="sm" className="view-button" icon={
          <>
            <Eye />
            <ChevronDown className="view-caret" aria-hidden />
          </>
        } label="View" hint="Which connections and crews the board shows" pressed={open} />
    </Popover>
  );
}
