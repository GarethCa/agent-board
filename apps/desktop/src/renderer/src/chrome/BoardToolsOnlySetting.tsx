import { useEffect, useState } from 'react';
import { Fieldset, Hint, Switch } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** The roles Settings can keep to the board's tools, by the name an agent's role goes by. */
const ROLES = [
  { role: 'implementer', label: 'Implementers' },
  { role: 'reviewer', label: 'Reviewers' },
  { role: 'designer', label: 'Designers' },
] as const;

/**
 * Which roles' new Claude agents get the board's MCP tools and no others: none of the user's own MCP servers or
 * claude.ai connectors, whose tools every turn reads again. Off for each by default. Codex agents are not touched.
 */
export function BoardToolsOnlySetting({ onError }: { onError: OnError }) {
  const [saved, setSaved] = useState<string[]>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setSaved(settings.boardToolsOnly), onError('read the board tools setting'));
  }, [onError]);

  const change = (role: string, on: boolean) => {
    if (saved === undefined) return;
    const boardToolsOnly = on ? [...saved.filter((name) => name !== role), role] : saved.filter((name) => name !== role);
    window.agentBoard.flowEdges.setSettings({ boardToolsOnly }).then((settings) => setSaved(settings.boardToolsOnly), onError('change the board tools setting'));
  };

  return (
    <Fieldset legend="Board tools only">
      <Hint>New Claude agents in these roles get the board's tools, not your other MCP servers or claude.ai connectors, so each turn costs less. Codex agents are not changed.</Hint>
      {ROLES.map(({ role, label }) => (
        <Switch
          key={role}
          label={label}
          checked={saved?.includes(role) ?? false}
          disabled={saved === undefined}
          onChange={(event) => change(role, event.currentTarget.checked)}
        />
      ))}
    </Fieldset>
  );
}
