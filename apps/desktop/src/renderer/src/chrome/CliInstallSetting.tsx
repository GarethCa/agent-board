import { useState } from 'react';
import { Button, Field } from '../ui';

/**
 * Settings › Command line: links the `agent-board` CLI into `~/.local/bin`, as VS Code installs `code`, for terminals
 * outside the app. Sessions the app starts have it already.
 */
export function CliInstallSetting({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const [installed, setInstalled] = useState<string>();
  const [busy, setBusy] = useState(false);

  const install = () => {
    setBusy(true);
    window.agentBoard.setup
      .installCli()
      .then(setInstalled, onError('install the command-line tool'))
      .finally(() => setBusy(false));
  };

  return (
    <Field
      label="Command line"
      hint={
        installed === undefined
          ? 'Sessions started here have agent-board already. This links it into ~/.local/bin for other terminals.'
          : `Linked ${installed}. Run agent-board --help; ~/.local/bin must be on your PATH.`
      }
    >
      <Button size="sm" loading={busy} onClick={install}>
        Install command-line tool
      </Button>
    </Field>
  );
}
