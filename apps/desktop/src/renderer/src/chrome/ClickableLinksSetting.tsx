import { useEffect, useState } from 'react';
import type { Agent, DaemonSettings } from '@agent-board/daemon/protocol';
import { ipcErrorMessage } from '../../../shared/errors';
import { canRestartLive } from '../session/RestartAgent';
import { Button, ErrorText, Hint, Switch } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** The live Claude agents this daemon started, which were started the other way from `on`. */
const startedOtherwise = (agents: Map<string, Agent>, on: boolean): Agent[] =>
  [...agents.values()].filter((agent) => agent.harness === 'claude' && agent.endedAt === null && agent.clickableLinks !== null && agent.clickableLinks !== on);

/**
 * Whether the Claude agents the app starts get `FORCE_HYPERLINK=1`, so the links they print open on ⌘-click. On by
 * default. A change reaches agents started or restarted afterwards; for the running Claude agents started the other
 * way, a line offers to restart them, never on its own. Codex agents and shells are not touched.
 */
export function ClickableLinksSetting({ onError }: { onError: OnError }) {
  const [on, setOn] = useState<DaemonSettings['clickableLinks']>();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  /** Agents the offer was dismissed for with Later: it comes back when the switch changes. */
  const [later, setLater] = useState(false);
  /** Why a restart did not go through, one line per agent. */
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setOn(settings.clickableLinks), onError('read the clickable links setting'));
    const offSettings = window.agentBoard.flowEdges.onSettingsChanged((event) => setOn(event.settings.clickableLinks));
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
      .then((settings) => setOn(settings.clickableLinks), onError('change the clickable links setting'))
      .finally(() => setBusy(false));
  };

  const stale = on === undefined ? [] : startedOtherwise(agents, on);
  const restartable = stale.filter(canRestartLive);
  /** Reviewers and the like: their restart is refused, so they take the setting when they next start. */
  const kept = stale.length - restartable.length;

  const restart = async () => {
    setBusy(true);
    setProblems([]);
    const failed: string[] = [];
    // One at a time, and one agent's trouble never leaves the rest unrestarted.
    for (const agent of restartable) {
      try {
        await window.agentBoard.agents.stop(agent.sessionId);
        const result = await window.agentBoard.agents.restart(agent.sessionId);
        if (result.status === 'busy') failed.push(`${agent.name} is stopped, as its shell is running something (${result.message}). Restart it from its tile.`);
      } catch (error) {
        failed.push(`${agent.name} could not be restarted: ${ipcErrorMessage(error)}`);
      }
    }
    setProblems(failed);
    setBusy(false);
  };

  const count = restartable.length;
  return (
    <>
      <Switch label="Clickable links from Claude" checked={on ?? true} disabled={on === undefined || busy} onChange={(event) => change(event.target.checked)} />
      <Hint>
        Sets <code>FORCE_HYPERLINK=1</code> for Claude agents, so the links they print open on ⌘-click. Every command Claude runs inherits it, so a tool&apos;s
        output can carry link escape codes, which Claude then reads back. Codex agents and shells are not affected; a value you set yourself is kept.
      </Hint>
      {count > 0 && !later && (
        <Hint data-testid="clickable-links-restart">
          {count} running Claude agent{count === 1 ? '' : 's'} started {on ? 'without' : 'with'} it. Restarting ends the turn {count === 1 ? 'it is' : 'each is'} on.{' '}
          <Button size="sm" disabled={busy} onClick={() => void restart()}>
            Restart {count === 1 ? 'it' : 'them'}
          </Button>{' '}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLater(true)}>
            Later
          </Button>
        </Hint>
      )}
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
