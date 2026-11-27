import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { isMidTurn, launchSettingNames, type Agent, type LaunchSettings } from '@agent-board/daemon/protocol';
import { ipcErrorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Field, Hint, IconButton, Tag, Textarea } from '../ui';
import { parseEnvLines } from './launch-env';

/**
 * ⋯ › Restart with…: the env vars the agent starts with from now on, then a restart that carries on its conversation.
 * Its values are never shown: the env vars it keeps are listed by name, each kept unless removed, and what is typed is
 * added on top (a kept name typed again takes the new value). Its Claude settings stay as they are.
 */
export function RestartWithDialog({
  agent,
  onClose,
  onRestart,
}: {
  agent: Agent;
  onClose(): void;
  /** Restarts it with `launchSettings`, keeping the env vars `keepEnv` names; rejects with why it couldn't. */
  onRestart(launchSettings: LaunchSettings, keepEnv: string[]): Promise<void>;
}) {
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const keepEnv = (agent.launchSettings?.env ?? []).filter((name) => !removed.has(name));
  const settings = launchSettingNames(agent.launchSettings === null ? null : { env: [], settings: agent.launchSettings.settings });
  const midTurn = agent.endedAt === null && isMidTurn(agent);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseEnvLines(text);
    if ('error' in parsed) return setError(parsed.error);
    setRestarting(true);
    setError(undefined);
    onRestart({ env: parsed.env }, keepEnv).then(onClose, (failure: unknown) => {
      setRestarting(false);
      setError(ipcErrorMessage(failure));
    });
  };
  return (
    <Dialog
      aria-label="Restart with"
      title={`Restart ${agent.name} with…`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={midTurn ? 'danger' : 'primary'} loading={restarting}>
            {restarting ? 'Restarting…' : midTurn ? 'Stop and restart' : 'Restart'}
          </Button>
        </>
      }
    >
      {keepEnv.length > 0 && (
        <Field label="Env vars it keeps" hint="Their values stay hidden. Remove one to start without it.">
          <div data-testid="restart-with-kept-env">
            {keepEnv.map((name) => (
              <Tag key={name} mono>
                {name}
                <IconButton icon={<X />} size="sm" aria-label={`Remove ${name}`} onClick={() => setRemoved((before) => new Set(before).add(name))} />
              </Tag>
            ))}
          </div>
        </Field>
      )}
      <Field label={keepEnv.length > 0 ? 'More env vars' : 'Env vars'} hint="NAME=value, one a line. A name it keeps takes the value typed here.">
        <Textarea rows={3} value={text} autoFocus spellCheck={false} placeholder="NAME=value" onChange={(event) => setText(event.target.value)} />
      </Field>
      <Hint data-testid="restart-with-kept">
        {settings === undefined ? '' : `It keeps its ${settings}. `}
        {midTurn ? 'It is mid-turn: this stops it now, and it carries on from where it was.' : 'Its conversation carries on.'}
      </Hint>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
