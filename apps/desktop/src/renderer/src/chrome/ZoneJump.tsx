import type { CSSProperties } from 'react';
import type { Zone } from '@agent-board/daemon/protocol';
import { CircleHelp } from 'lucide-react';
import { useExtendedShortcuts } from '../keys/extended-shortcuts';
import { keyText } from '../keys/registry';
import { Button, Island, IslandSeparator, ToolButton } from '../ui';

/** The bottom-left island (chrome C): a button per zone that brings it into view, and the keyboard cheat sheet's button. */
export function ZoneJump({ zones, onJump, onKeyboardHelp }: { zones: readonly Zone[]; onJump(zone: Zone): void; onKeyboardHelp(): void }) {
  const extended = useExtendedShortcuts();
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
      <ToolButton size="sm" icon={<CircleHelp />} label="Keyboard shortcuts" shortcut={extended ? keyText('move.cheatSheet') : undefined} onClick={onKeyboardHelp} />
    </Island>
  );
}
