import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { SquareArrowOutUpRight, Timer } from 'lucide-react';
import { commandLine } from '../board/command-row';
import { useNow } from '../inbox/use-now';
import { Button, Popover } from '../ui';

export interface RunningCountProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
}

/** The live agents waiting on a command they left running, in board order. */
function onCommand(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.endedAt === null && agent.state === 'on-command');
}

/**
 * The quiet count beside the Needs-you pill: how many agents wait on a command they left running, which Needs you leaves
 * out. It opens a list of them, each with its command and how long it has run. Nothing shows while none does.
 */
export function RunningCount({ agents, onOpen }: RunningCountProps) {
  const [open, setOpen] = useState(false);
  const running = onCommand(agents);
  const now = useNow(open);
  if (running.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label="Running"
      align="end"
      className="running-popover"
      content={
        <section className="running-list" data-testid="running-list" aria-label="Running in the background">
          <header className="running-list-head">
            <h2>On a command</h2>
          </header>
          <ul>
            {running.map((agent) => {
              const line = commandLine(agent, now);
              return (
                <li key={agent.sessionId} data-testid="running-item" data-session-id={agent.sessionId}>
                  <span className="running-item-name">{agent.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<SquareArrowOutUpRight />}
                    aria-label={`Open ${agent.name}`}
                    onClick={() => {
                      setOpen(false);
                      onOpen(agent);
                    }}
                  >
                    Open
                  </Button>
                  {line !== undefined && (
                    <span className="running-item-command">
                      <span className="running-item-text">{line.command}</span>
                      {line.more > 0 && <span>+{line.more}</span>}
                      <b>{line.elapsed}</b>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      }
    >
      <Button size="md" variant="ghost" className="running-count" data-testid="running-count" data-count={running.length} icon={<Timer aria-hidden />}>
        {running.length} running
      </Button>
    </Popover>
  );
}
