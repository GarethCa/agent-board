import { useEffect, useState } from 'react';
import type { ExternalHooksStatus } from '@agent-board/daemon/protocol';
import { Hint, Switch } from '../ui';
import { useDaemonStatus } from '../DaemonStatus';
import { tildify } from '../session/live-folder';

/**
 * The opt-in setting for external sessions: installs global hooks in `~/.claude/settings.json` and
 * `~/.codex/hooks.json` that report sessions started in any terminal, or takes them out again.
 */
export function ExternalHooksToggle({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const [status, setStatus] = useState<ExternalHooksStatus>();
  const [busy, setBusy] = useState(false);
  const daemon = useDaemonStatus();
  const home = daemon.state === 'connected' ? daemon.health.homeDir : undefined;

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

  const paths = status ? Object.values(status.harnesses).map((harness) => tildify(harness.path, home)) : [];
  return (
    <>
      <Switch
        label="Show sessions from other terminals"
        checked={status?.enabled ?? false}
        disabled={status === undefined || busy}
        onChange={(event) => toggle(event.target.checked)}
      />
      <Hint>
        Claude and Codex sessions you start in any terminal show on the board while agent-board runs. This adds a hook to{' '}
        {paths.join(' and ') || 'your Claude and Codex settings'}, which Codex asks you to review the first time. Turn it
        off before you uninstall agent-board or delete ~/.agent-board, or every session runs a hook that is gone.
      </Hint>
    </>
  );
}
