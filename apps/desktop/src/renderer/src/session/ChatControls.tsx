import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '../ui';
import type { RunsMode } from './chat';
import { ChatAgentsButton } from './ChatAgentsFilter';
import { ChatStyleSwitch } from './ChatStyleSwitch';
import type { ChatRunsShow } from './chat-runs-show';

export interface ChatControlsProps {
  sessionId: string;
  /** Whether the chat style switch is among them: not where the header has the Chat | Timeline | Terminal switch. */
  styleSwitch: boolean;
  /** Whether Expand all and Collapse all always show, or wait for the pointer over the header or tab row (the setting). */
  runsShow: ChatRunsShow;
  onRuns(mode: RunsMode): void;
}

/**
 * The chat's own controls, while the chat shows: its style, which agents' messages it shows, and Expand all and
 * Collapse all. They sit on the window's tab row where it has one, else in its header; the strip over the
 * chat keeps only the pane and its status. Whose messages is the one-button form, as in the Captain's panel: the
 * two-word switch would push a header's Close out of the window.
 */
export function ChatControls({ sessionId, styleSwitch, runsShow, onRuns }: ChatControlsProps) {
  return (
    <span className="chat-controls">
      {styleSwitch && <ChatStyleSwitch />}
      <ChatAgentsButton sessionId={sessionId} />
      <span className="chat-runs-actions" data-shows={runsShow}>
        <Button variant="ghost" size="xs" icon={<ChevronsUpDown />} onClick={() => onRuns('expanded')} tooltip="Open every call and run of calls" aria-label="Expand all">
          <span className="chat-runs-label">Expand all</span>
        </Button>
        <Button variant="ghost" size="xs" icon={<ChevronsDownUp />} onClick={() => onRuns('collapsed')} tooltip="Close every call and run of calls" aria-label="Collapse all">
          <span className="chat-runs-label">Collapse all</span>
        </Button>
      </span>
    </span>
  );
}
