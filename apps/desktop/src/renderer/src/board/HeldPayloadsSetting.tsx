import { useEffect, useState } from 'react';
import type { HeldPayloadStorage } from '@agent-board/daemon/protocol';
import { Field, Select } from '../ui';

/**
 * Where a hand-off an edge holds (or queues) keeps its file meanwhile: a copy in the daemon's database, delivered as
 * it was, or only its path, the file read again when it is delivered. Keeping only paths drops the copies held now.
 */
export function HeldPayloadsSetting({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const [storage, setStorage] = useState<HeldPayloadStorage>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setStorage(settings.heldPayloads), onError('read where held hand-offs are kept'));
  }, [onError]);

  const change = (heldPayloads: HeldPayloadStorage) => {
    setBusy(true);
    window.agentBoard.flowEdges
      .setSettings({ heldPayloads })
      .then((settings) => setStorage(settings.heldPayloads), onError('change where held hand-offs are kept'))
      .finally(() => setBusy(false));
  };

  return (
    <Field
      label="Held hand-offs"
      hint={
        storage === 'path'
          ? "Only the file's path is kept; it is read again when the hand-off is sent."
          : 'A copy of the file is kept until the hand-off is sent or dropped.'
      }
    >
      <Select
        size="sm"
        value={storage ?? 'copy'}
        disabled={storage === undefined || busy}
        onChange={(event) => change(event.target.value as HeldPayloadStorage)}
      >
        <option value="copy">Keep a copy (default)</option>
        <option value="path">Path only, read at delivery</option>
      </Select>
    </Field>
  );
}
