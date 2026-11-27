import { useEffect, useId, useState } from 'react';
import type { Agent, DaemonSettings } from '@agent-board/daemon/protocol';
import { ipcErrorMessage } from '../../../shared/errors';
import { keyText } from '../keys/registry';
import { canRestartLive, WakeBusyConfirm } from '../session/RestartAgent';
import { Button, ErrorText, Hint, Switch } from '../ui';
import { cancelledLine, clickableLinksView, restartForLinks, startedOtherwise, wakeAnyway, type BusyShell } from './clickable-links';

type OnError = (action: string) => (error: unknown) => void;
type LinkSettings = Pick<DaemonSettings, 'clickableLinks' | 'clickableLinksFromEnvironment'>;

const linkSettings = ({ clickableLinks, clickableLinksFromEnvironment }: DaemonSettings): LinkSettings => ({ clickableLinks, clickableLinksFromEnvironment });

/**
 * Whether the Claude agents the app starts get `FORCE_HYPERLINK=1`, so the links they print open on ⌘-click. On by
 * default. A change reaches agents started or restarted afterwards; for the running Claude agents started the other
 * way, a line offers to restart them, never on its own. Codex agents and shells are not touched. A `FORCE_HYPERLINK` the
 * user set in their own environment wins: the switch shows it, locked.
 */
export function ClickableLinksSetting({ onError }: { onError: OnError }) {
  const [settings, setSettings] = useState<LinkSettings>();
  const lockId = useId();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  /** Agents the offer was dismissed for with Later: it comes back when the switch changes. */
  const [later, setLater] = useState(false);
  /** Why a restart did not go through, one line per agent. */
  const [problems, setProblems] = useState<string[]>([]);
  /** Agents stopped for the restart whose shell runs something: each asks, as Wake does, before it ends that. */
  const [busyShells, setBusyShells] = useState<BusyShell[]>([]);

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((now) => setSettings(linkSettings(now)), onError('read the clickable links setting'));
    const offSettings = window.agentBoard.flowEdges.onSettingsChanged((event) => setSettings(linkSettings(event.settings)));
    window.agentBoard.agents.list().then((list) => setAgents((now) => new Map([...list.map((agent): [string, Agent] => [agent.sessionId, agent]), ...now])), onError('read the agents'));
    const offAgents = window.agentBoard.agents.onChanged((change) =>
      setAgents((now) => {
        const next = new Map(now);
        if (change.type === 'agent.removed') next.delete(change.sessionId);
        else next.set(change.agent.sessionId, change.agent);
        return next;
      }),
    );
    return () => {
      offSettings();
      offAgents();
    };
  }, [onError]);

  const change = (clickableLinks: boolean) => {
    setBusy(true);
    setLater(false);
    setProblems([]);
    window.agentBoard.flowEdges
      .setSettings({ clickableLinks })
      .then((now) => setSettings(linkSettings(now)), onError('change the clickable links setting'))
      .finally(() => setBusy(false));
  };

  const { checked, locked } = clickableLinksView(settings);
  const stale = startedOtherwise(agents.values(), settings);
  const restartable = stale.filter(canRestartLive);
  /** Reviewers and the like: their restart is refused, so they take the setting when they next start. */
  const kept = stale.length - restartable.length;

  const restart = async () => {
    setBusy(true);
    setProblems([]);
    setBusyShells([]);
    const { failed, asking } = await restartForLinks(restartable, window.agentBoard.agents, ipcErrorMessage);
    setProblems(failed);
    setBusyShells(asking);
    setBusy(false);
  };

  const settle = (shell: BusyShell, problem?: string) => {
    setBusyShells((now) => now.filter((each) => each.sessionId !== shell.sessionId));
    if (problem !== undefined) setProblems((now) => [...now, problem]);
  };
  const wake = async (shell: BusyShell) => {
    setBusy(true);
    const woke = await wakeAnyway(shell, window.agentBoard.agents, ipcErrorMessage);
    if (!woke.asking) settle(shell, woke.problem);
    setBusy(false);
  };

  const count = restartable.length;
  return (
    <>
      <Switch
        label="Clickable links from Claude"
        checked={checked}
        disabled={settings === undefined || locked || busy}
        aria-describedby={locked ? lockId : undefined}
        onChange={(event) => change(event.target.checked)}
      />
      {locked && (
        <Hint id={lockId} data-testid="clickable-links-environment">
          Set in your environment ({checked ? 'on' : 'off'}): your own <code>FORCE_HYPERLINK</code> wins, so this switch changes nothing until you remove it
          there.
        </Hint>
      )}
      <Hint>
        Sets <code>FORCE_HYPERLINK=1</code> for Claude agents, so the links they print open on {keyText('window.openLink')}. Every command Claude runs inherits
        it, so a tool&apos;s output can carry link escape codes, which Claude then reads back. Codex agents and shells are not affected.
      </Hint>
      {count > 0 && !later && (
        <Hint data-testid="clickable-links-restart">
          {count} running Claude agent{count === 1 ? '' : 's'} started {settings?.clickableLinks ? 'without' : 'with'} it. Restarting ends the turn {count === 1 ? 'it is' : 'each is'} on.{' '}
          <Button size="sm" disabled={busy} onClick={() => void restart()}>
            Restart {count === 1 ? 'it' : 'them'}
          </Button>{' '}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLater(true)}>
            Later
          </Button>
        </Hint>
      )}
      {busyShells.map((shell) => (
        <WakeBusyConfirm
          key={shell.sessionId}
          message={`${shell.name} is stopped: ${shell.message}`}
          pending={busy}
          onWake={() => void wake(shell)}
          onCancel={() => settle(shell, cancelledLine(shell))}
        />
      ))}
      {problems.map((problem) => (
        <ErrorText key={problem}>{problem}</ErrorText>
      ))}
      {kept > 0 && !later && (
        <Hint data-testid="clickable-links-kept">
          {kept} more ({kept === 1 ? 'a reviewer or an agent' : 'reviewers or agents'} that can&apos;t be restarted in place) will take it when {kept === 1 ? 'it starts' : 'they start'} next.
        </Hint>
      )}
    </>
  );
}
