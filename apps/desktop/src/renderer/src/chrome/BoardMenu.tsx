import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { LifeBuoy, Menu as MenuIcon, Plus, Search } from 'lucide-react';
import { APP_NAME } from '../../../shared/brand';
import { DaemonStatus, type DaemonStatusValue } from '../DaemonStatus';
import { withCommand } from '../keys';
import { Sessions } from '../Sessions';
import { Button, EmptyState, Input, Island, IslandSeparator, Kbd, PanelRow, Popover, Section, ToolButton, Tooltip } from '../ui';
import { BrandMark } from './BrandMark';
import { Settings, type SettingsProps } from './Settings';

/** Whether the board menu is open, and where it put the focus as it opened: its search field, or its settings. */
export type BoardMenuState = { open: false } | { open: true; at?: 'search' | 'settings'; asked?: number };

export interface BoardMenuProps extends SettingsProps {
  menu: BoardMenuState;
  onMenu(menu: BoardMenuState): void;
  status: DaemonStatusValue;
  /** Undefined until the board has loaded them. */
  zones: readonly Zone[] | undefined;
  agents: readonly Agent[];
  shells: readonly Shell[] | undefined;
  /** Brings the zone into view. */
  onJump(zone: Zone): void;
  /** Opens Add zone, in the middle of the view. */
  onAddZone(): void;
  onOpenAgent(agent: Agent): void;
  onOpenShell(shell: Shell): void;
  /** Reopens onboarding; the Help section's Getting started row shows only while it is set. */
  onGettingStarted?(): void;
}

/**
 * The board menu, the top-left island (chrome C): the app's mark and the board's name, the daemon's status, and a
 * panel with the zones, the agents and shells, and the settings. Its search field (⌘K) narrows the zones and agents
 * by name, a placeholder for a command palette.
 */
export function BoardMenu({ menu, onMenu, status, zones, agents, shells, onJump, onAddZone, onOpenAgent, onOpenShell, onGettingStarted, ...settings }: BoardMenuProps) {
  const [filter, setFilter] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const settingsSection = useRef<HTMLElement>(null);
  const at = menu.open ? menu.at : undefined;
  /** When it was last asked to focus there: asked again while open, it focuses again. */
  const asked = menu.open ? menu.asked : undefined;

  // Once the panel has mounted, the focus goes where it was opened for.
  useEffect(() => {
    if (at === undefined) return;
    const frame = requestAnimationFrame(() => {
      if (at === 'search') search.current?.focus();
      else {
        settingsSection.current?.scrollIntoView({ block: 'nearest' });
        settingsSection.current?.querySelector('button')?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [at, asked]);

  const close = () => onMenu({ open: false });
  const wanted = filter.trim().toLowerCase();
  const shownZones = zones?.filter((zone) => zone.name.toLowerCase().includes(wanted));
  const panel = (
    <div className="board-menu-panel">
      <div className="board-menu-search">
        <Input
          ref={search}
          size="sm"
          type="search"
          aria-label="Find a zone or agent"
          placeholder="Find a zone or agent…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="board-menu-sections">
        <Section label="Zones" meta={zones === undefined ? undefined : zones.length === 0 ? 'None' : String(zones.length)}>
          {shownZones !== undefined && shownZones.length > 0 ? (
            <ul className="board-menu-list">
              {shownZones.map((zone) => {
                const count = agents.filter((agent) => agent.zoneId === zone.id).length;
                return (
                  <li key={zone.id}>
                    <Tooltip content="Show it on the board">
                      <PanelRow
                        as="button"
                        mark={<span className="board-menu-swatch" style={{ '--zone-color': zone.color } as CSSProperties} aria-hidden />}
                        name={zone.name}
                        end={count === 1 ? '1 agent' : `${count} agents`}
                        quietEnd
                        onClick={() => {
                          close();
                          onJump(zone);
                        }}
                      />
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState framed={false} title={zones?.length ? 'No zones match' : 'No zones yet'} />
          )}
          <div className="board-menu-actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus />}
              onClick={() => {
                close();
                onAddZone();
              }}
            >
              Add a zone
            </Button>
          </div>
        </Section>
        <Sessions agents={agents} shells={shells} filter={filter} onPicked={close} onOpenAgent={onOpenAgent} onOpenShell={onOpenShell} />
        <Section ref={settingsSection} label="Settings">
          <Settings status={status} {...settings} />
        </Section>
        {onGettingStarted !== undefined && (
          <Section label="Help">
            <div className="board-menu-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<LifeBuoy />}
                onClick={() => {
                  close();
                  onGettingStarted();
                }}
              >
                Getting started
              </Button>
            </div>
          </Section>
        )}
      </div>
    </div>
  );

  return (
    <Island className="board-menu island-top-left" data-testid="board-menu" data-tour="board-menu" data-drag-region>
      <Popover open={menu.open} onOpenChange={(open) => onMenu({ open })} aria-label="Board menu" content={panel} className="board-menu-popover">
        <ToolButton size="sm" icon={<MenuIcon />} label="Board menu" hint={`Zones, agents and settings  ${withCommand('\\')}`} />
      </Popover>
      <BrandMark className="board-menu-logo" />
      <h1 className="board-menu-title">{APP_NAME}</h1>
      <DaemonStatus status={status} />
      <IslandSeparator />
      <Button
        size="sm"
        variant="ghost"
        className="board-menu-find"
        icon={<Search />}
        aria-label="Find"
        tooltip="Find a zone or agent"
        onClick={() => onMenu({ open: true, at: 'search' })}
      >
        <Kbd>{withCommand('K')}</Kbd>
      </Button>
    </Island>
  );
}
