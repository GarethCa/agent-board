import { useEffect, useRef, type CSSProperties } from 'react';
import type { Zone } from '@agent-board/daemon/protocol';
import { CircleHelp } from 'lucide-react';
import { useExtendedShortcuts } from '../keys/extended-shortcuts';
import { keyText } from '../keys/registry';
import { Button, Island, IslandSeparator, ToolButton, useSidewaysScroll } from '../ui';

/**
 * The bottom-left island (chrome C): a button per zone that brings it into view, and the keyboard cheat sheet's button.
 * The zones scroll sideways inside it, and the current one (the zone last brought into view, by this island, the board
 * menu or ⌘K) is marked, and kept in view as the zones change and the window is resized.
 */
export function ZoneJump({ zones, current, onJump, onKeyboardHelp }: { zones: readonly Zone[]; current?: string; onJump(zone: Zone): void; onKeyboardHelp(): void }) {
  const extended = useExtendedShortcuts();
  const track = useRef<HTMLDivElement | null>(null);
  // A zone that has gone is no longer current.
  const currentId = zones.find((zone) => zone.id === current)?.id;
  useSidewaysScroll(track, zones.length > 0);
  useEffect(() => {
    const element = track.current;
    if (element === null || currentId === undefined) return;
    const show = () => [...element.children].find((child) => (child as HTMLElement).dataset.zoneId === currentId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    show();
    globalThis.addEventListener('resize', show);
    return () => globalThis.removeEventListener('resize', show);
    // Keyed on the zone and whether there are any, not the zones array, which is rebuilt on every board change: the pill
    // must not snap back while it is being browsed. Nor does it as the islands beside it change width (the zoom going from
    // 99% to 100%): only the window being resized brings the current zone back into view.
  }, [currentId, zones.length > 0]);
  return (
    <Island className="zone-jump island-bottom-left" role="group" aria-label="Zones">
      {zones.length > 0 && (
        <div className="zone-jump-track" ref={track} data-testid="zone-jump-track">
          {zones.map((zone) => (
            <Button
              key={zone.id}
              size="sm"
              variant="ghost"
              className="zone-jump-zone"
              data-zone-id={zone.id}
              aria-current={zone.id === currentId || undefined}
              icon={<span className="board-menu-swatch" style={{ '--zone-color': zone.color } as CSSProperties} aria-hidden />}
              tooltip="Show it on the board"
              onClick={() => onJump(zone)}
            >
              {zone.name}
            </Button>
          ))}
        </div>
      )}
      {zones.length > 0 && <IslandSeparator />}
      <ToolButton size="sm" icon={<CircleHelp />} label="Keyboard shortcuts" shortcut={extended ? keyText('move.cheatSheet') : undefined} onClick={onKeyboardHelp} />
    </Island>
  );
}
