import type { CSSProperties } from 'react';
import type { Zone } from '@agent-board/daemon/protocol';
import { CircleHelp } from 'lucide-react';
import { RESET_ROTATION_KEY } from '../board/editing/context-menu';
import { ROTATION_SNAP } from '../board/items/rotation';
import { withCommand } from '../keys';
import { Button, Island, IslandSeparator, Popover, Shortcut, ToolButton } from '../ui';

/** The keys the board answers to, for the help popover. */
const SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: ['V'], does: 'Select and move' },
  { keys: ['H'], does: 'Pan the board' },
  { keys: ['N'], does: 'Sticky note at the pointer' },
  { keys: ['T'], does: 'Text: then click' },
  { keys: ['S'], does: 'Shape: then drag' },
  { keys: ['⇧'], does: `Turning with the rotate handle: ${ROTATION_SNAP}° steps` },
  { keys: [RESET_ROTATION_KEY], does: 'Reset the rotation of what is selected' },
  { keys: [withCommand('K')], does: 'Find a zone or session' },
  { keys: [withCommand('\\')], does: 'Open or close the board menu' },
  { keys: [withCommand('I')], does: "A session window's details" },
  { keys: ['Esc'], does: 'Put the armed tool down' },
];

/** The bottom-left island (chrome C): a button per zone that brings it into view, and the board's keys. */
export function ZoneJump({ zones, onJump }: { zones: readonly Zone[]; onJump(zone: Zone): void }) {
  return (
    <Island className="zone-jump island-bottom-left" role="group" aria-label="Zones">
      {zones.map((zone) => (
        <Button
          key={zone.id}
          size="sm"
          variant="ghost"
          className="zone-jump-zone"
          icon={<span className="board-menu-swatch" style={{ '--zone-color': zone.color } as CSSProperties} aria-hidden />}
          tooltip="Show it on the board"
          onClick={() => onJump(zone)}
        >
          {zone.name}
        </Button>
      ))}
      {zones.length > 0 && <IslandSeparator />}
      <Popover
        aria-label="Keyboard shortcuts"
        side="top"
        content={
          <ul className="shortcut-list">
            {SHORTCUTS.map(({ keys, does }) => (
              <li key={does}>
                <Shortcut keys={keys}>{does}</Shortcut>
              </li>
            ))}
          </ul>
        }
      >
        <ToolButton size="sm" icon={<CircleHelp />} label="Keyboard shortcuts" />
      </Popover>
    </Island>
  );
}
