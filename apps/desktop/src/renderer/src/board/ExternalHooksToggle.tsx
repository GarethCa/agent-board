import { useEffect, useState } from 'react';
import type { ExternalHooksStatus } from '@agent-board/daemon/protocol';
import { Switch } from '../ui';

/**
 * The opt-in setting for external sessions: installs global hooks in `~/.claude/settings.json` and
 * `~/.codex/hooks.json` that report sessions started in any terminal, or takes them out again.
 */
export function ExternalHooksToggle({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const [status, setStatus] = useState<ExternalHooksStatus>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.agentBoard.external.hooksStatus().then(setStatus, onError('check the global hooks'));
  }, [onError]);

  const toggle = (enabled: boolean) => {
    setBusy(true);
    window.agentBoard.external
      .setHooksEnabled(enabled)
      .then(setStatus, onError(enabled ? 'install the global hooks' : 'remove the global hooks'))
      .finally(() => setBusy(false));
  };

  const paths = status ? Object.values(status.harnesses).map((harness) => harness.path) : [];
  return (
    <Switch
      label="Other terminals"
      aria-label="Show sessions from other terminals"
      title={
        `Adds a hook to ${paths.join(' and ') || 'your Claude and Codex settings'} that reports sessions started in ` +
        `any terminal while agent-board runs. Codex asks you to review it the first time. Untick this before ` +
        `uninstalling agent-board or deleting ~/.agent-board, or every session will run a hook that is gone.`
      }
      checked={status?.enabled ?? false}
      disabled={status === undefined || busy}
      onChange={(event) => toggle(event.target.checked)}
    />
  );
}
