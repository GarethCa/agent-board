import { useState } from 'react';
import type { Zone } from '@agent-board/daemon/protocol';
import { gateCommandArgv } from '@agent-board/daemon/gate-rules';
import { Button, Dialog, ErrorText, Field, Hint, Input } from '../ui';
import { useAction } from '../use-action';

/** Why the command can't be a gate command, or undefined: none at all is fine (no gate). */
function commandProblem(command: string): string | undefined {
  if (command.trim() === '') return undefined;
  try {
    gateCommandArgv(command);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Sets a zone's gate command: what checks an agent's work before it is merged, run in the agent's worktree only
 * when the user asks. It runs through `sh -c`, as typed in a terminal.
 */
export function GateCommandDialog({ zone, onSaved, onCancel }: { zone: Zone; onSaved(zone: Zone): void; onCancel(): void }) {
  const [command, setCommand] = useState(zone.gateCommand ?? '');
  const { busy, error, run } = useAction();
  const problem = commandProblem(command);
  const save = (next: string | null) => run(() => window.agentBoard.zones.configure(zone.id, { gateCommand: next }), onSaved);
  return (
    <Dialog
      aria-label="Gate command"
      title={`The gate for ${zone.name}`}
      onClose={onCancel}
      footerStart={
        zone.gateCommand !== null && (
          <Button variant="danger" disabled={busy} onClick={() => save(null)}>
            Remove the gate
          </Button>
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={problem !== undefined} onClick={() => save(command.trim() === '' ? null : command)} data-testid="gate-command-save">
            Save
          </Button>
        </>
      }
    >
      <Field label="Gate command" hint={problem === undefined ? undefined : <ErrorText>{problem}</ErrorText>}>
        <Input name="gate-command" value={command} placeholder="pnpm check:local" spellCheck={false} autoFocus onChange={(event) => setCommand(event.target.value)} />
      </Field>
      <Hint>
        Run in an agent&rsquo;s worktree when you click Run gate, never by itself. It runs through <code>sh -c</code>, so{' '}
        <code>&amp;&amp;</code> and pipes work. Lines like <code>::gate start lint</code> in its output mark its steps.
      </Hint>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
