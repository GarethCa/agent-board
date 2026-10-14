import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { ChevronDown, ChevronUp, Settings as SettingsIcon } from 'lucide-react';
import { Inbox } from '../inbox/Inbox';
import { needsYou } from '../../../shared/needs-you';
import { Button, Island, Popover, ToolButton } from '../ui';

export interface NeedsYouProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
  /** Opens the board menu at its settings. */
  onSettings(): void;
}

/**
 * The top-right island (chrome C): the Needs-you pill, which says how many agents wait for you and opens the inbox
 * over the board, and a gear that opens the board menu at its settings.
 */
export function NeedsYou({ agents, onOpen, onSettings }: NeedsYouProps) {
  const [open, setOpen] = useState(false);
  const count = needsYou(agents).length;
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
      <ToolButton size="sm" icon={<SettingsIcon />} label="Settings" hint="Settings, in the board menu" onClick={onSettings} />
    </Island>
  );
}
