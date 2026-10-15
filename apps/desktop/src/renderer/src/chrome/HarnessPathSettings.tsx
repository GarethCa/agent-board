import { useEffect, useState } from 'react';
import { Field, Input } from '../ui';

type HarnessPathKey = 'claudePath' | 'codexPath';
type OnError = (action: string) => (error: unknown) => void;

/**
 * Where `claude` and `codex` are, for a Mac where they are found only through a shell's rc file, or where the lookup
 * finds the wrong one. Empty looks for them: on the login shell's PATH, then at the places installers use.
 */
export function HarnessPathSettings({ onError }: { onError: OnError }) {
  const [saved, setSaved] = useState<Record<HarnessPathKey, string>>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then(
      (settings) => setSaved({ claudePath: settings.claudePath, codexPath: settings.codexPath }),
      onError('read the paths of claude and codex'),
    );
  }, [onError]);

  return (
    <>
      <HarnessPathField name="claudePath" label="Claude path" harness="claude" saved={saved?.claudePath} onError={onError} />
      <HarnessPathField name="codexPath" label="Codex path" harness="codex" saved={saved?.codexPath} onError={onError} />
    </>
  );
}

/** One path, as read; `saved` is undefined until it is. */
function HarnessPathField({
  name,
  label,
  harness,
  saved: read,
  onError,
}: {
  name: HarnessPathKey;
  label: string;
  harness: string;
  saved: string | undefined;
  onError: OnError;
}) {
  const [saved, setSaved] = useState<string>();
  const [text, setText] = useState('');

  useEffect(() => {
    setSaved(read);
    setText(read ?? '');
  }, [read]);

  const save = () => {
    if (saved === undefined || text.trim() === saved) return;
    window.agentBoard.flowEdges.setSettings({ [name]: text.trim() }).then(
      (settings) => {
        setSaved(settings[name]);
        setText(settings[name]);
      },
      (error: unknown) => {
        setText(saved);
        onError(`change the path of ${harness}`)(error);
      },
    );
  };

  return (
    <Field label={label} hint={`Absolute path of ${harness}. Empty looks for it where a terminal would, and where it is usually installed.`}>
      <Input
        size="sm"
        value={text}
        placeholder="Look for it"
        spellCheck={false}
        disabled={saved === undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
    </Field>
  );
}
