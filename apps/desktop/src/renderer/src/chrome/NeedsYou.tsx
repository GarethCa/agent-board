import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { ChevronDown, ChevronUp, Settings as SettingsIcon } from 'lucide-react';
import { Inbox } from '../inbox/Inbox';
import { RunningCount } from './RunningCount';
import { unseenCount } from '../../../shared/needs-you';
import { Button, Island, Popover, ToolButton } from '../ui';
import { useNeedsYouShows } from '../needs-you-setting';
import { keyText } from '../keys/registry';

export interface NeedsYouProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
  /** Opens the board menu at its settings. */
  onSettings(): void;
  /** Opens or closes the board master's panel. */
  onMaster(): void;
  /** Whether the master's panel is open. */
  masterOpen: boolean;
}

/**
 * The top-right island (chrome C): the Needs-you pill, which says how many agents wait for you and opens the inbox
 * over the board, the quiet count of agents on a command beside it, the board master's button, with the same count, and
 * a gear that opens the board menu at its settings.
 */
export function NeedsYou({ agents, onOpen, onSettings, onMaster, masterOpen }: NeedsYouProps) {
  const [open, setOpen] = useState(false);
  const count = unseenCount(agents, useNeedsYouShows());
  return (
    <Island className="needs-you island-top-right" data-tour="needs-you">
      <Popover
        open={open}
        onOpenChange={setOpen}
        aria-label="Needs you"
        align="end"
        className="needs-you-popover"
        content={
          <Inbox
            agents={agents}
            onOpen={(agent) => {
              setOpen(false);
              onOpen(agent);
            }}
            onSettings={() => {
              setOpen(false);
              onSettings();
            }}
          />
        }
      >
        <Button
          size="md"
          variant="ghost"
          className="needs-you-pill"
          data-testid="inbox-count"
          data-count={count}
          data-attention={count > 0}
          icon={<span className="needs-you-dot" aria-hidden />}
          trailingIcon={open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        >
          {count === 0 ? 'Nothing needs you' : `${count} need${count === 1 ? 's' : ''} you`}
        </Button>
      </Popover>
      <RunningCount agents={agents} onOpen={onOpen} />
      <Button
        size="md"
        variant="ghost"
        className="master-button"
        data-testid="master-button"
        aria-pressed={masterOpen}
        aria-label="Master"
        title={`The board master (${keyText('move.master')})`}
        icon={
          <span className="master-glyph" aria-hidden>
            M
          </span>
        }
        onClick={onMaster}
      >
        <span className="master-button-label">Master</span>
        {count > 0 && <span className="master-button-count">{count}</span>}
      </Button>
      <ToolButton size="sm" icon={<SettingsIcon />} label="Settings" hint="Settings, in the board menu" onClick={onSettings} />
    </Island>
  );
}
