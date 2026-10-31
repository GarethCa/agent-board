import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { ChevronDown, ChevronUp, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react';
import { Captain } from '../board/Character';
import { StatusGlyph } from '../board/StatusMark';
import { useSimplified } from '../design';
import { Inbox } from '../inbox/Inbox';
import { RunningCount } from './RunningCount';
import { unseenCount } from '../../../shared/needs-you';
import { Button, Island, Popover, ToolButton } from '../ui';
import { useNeedsYouShows } from '../needs-you-setting';
import { keyText } from '../keys/registry';
import type { PaneSide } from '../master/use-master-panel';

export interface NeedsYouProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
  /** Opens the Settings window. */
  onSettings(): void;
  /** Opens or closes the Captain's panel. */
  onMaster(): void;
  /** Under the Simplified design: opens the docked pane on the Needs-you list, or closes it from there. */
  onNeedsYou(): void;
  /** Whether the master's panel is open, and which side of it (the Captain's, in Classic). */
  pane: PaneSide | undefined;
}

/**
 * The top-right island (chrome C): the Needs-you pill, which says how many agents wait for you and opens the inbox
 * over the board, the quiet count of agents on a command beside it, the Captain's button, with the same count, and
 * a gear that opens the Settings window.
 *
 * Under the Simplified design it is three buttons: Needs you with its count, the Captain drawn as the character in the
 * pirate hat, with no count of its own, and the sliders that open Settings. Needs you and the Captain each open the one
 * docked pane on their own side, and a second click on the open side closes it.
 */
export function NeedsYou({ agents, onOpen, onSettings, onMaster, onNeedsYou, pane }: NeedsYouProps) {
  const [open, setOpen] = useState(false);
  const count = unseenCount(agents, useNeedsYouShows());
  const simplified = useSimplified();
  return (
    <Island className="needs-you island-top-right" data-tour="needs-you">
      {simplified ? (
        <Button
          size="md"
          variant="ghost"
          className="needs-you-pill"
          data-testid="inbox-count"
          data-count={count}
          data-attention={count > 0}
          aria-pressed={pane === 'needs-you'}
          icon={<StatusGlyph status="needs-you" />}
          onClick={onNeedsYou}
        >
          Needs you
          {count > 0 && <span className="needs-you-count">{count}</span>}
        </Button>
      ) : (
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
      )}
      {!simplified && <RunningCount agents={agents} onOpen={onOpen} />}
      <Button
        size="md"
        variant="ghost"
        className="master-button"
        data-testid="master-button"
        aria-pressed={pane === 'captain' || (pane !== undefined && !simplified)}
        aria-label="Captain"
        title={`The Captain (${keyText('move.master')})`}
        icon={
          simplified ? (
            <Captain size="toolbar" />
          ) : (
            <span className="master-glyph" aria-hidden>
              C
            </span>
          )
        }
        onClick={onMaster}
      >
        <span className="master-button-label">Captain</span>
        {!simplified && count > 0 && <span className="master-button-count">{count}</span>}
      </Button>
      <ToolButton size="sm" icon={simplified ? <SlidersHorizontal /> : <SettingsIcon />} label="Settings" hint="Settings" onClick={onSettings} />
    </Island>
  );
}
