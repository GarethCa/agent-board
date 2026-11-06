import { useEffect, useState } from 'react';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Hint, Tag } from '../ui';
import { useAction } from '../use-action';
import { PrefabIcon } from './icons';
import { PrefabEditor } from './PrefabEditor';
import { memberLabel } from './prefab-flow';

interface Library {
  prefabs: LibraryPrefab[];
  unreadable: { name: string; reason: string }[];
}

/**
 * The app's crew prefabs, one library for every board, from the board menu: each with its members and what it is for,
 * to edit (a built-in, as a copy of your own) or remove, and New prefab. Each opens the flow editor in its place.
 */
export function PrefabsDialog({ onClose }: { onClose(): void }) {
  const [library, setLibrary] = useState<Library>();
  const [loadError, setLoadError] = useState<string>();
  // undefined: the list; null: a new prefab; else the one being edited.
  const [editing, setEditing] = useState<LibraryPrefab | null>();
  // A prefab can't be got back once removed, so Remove asks first, in its row.
  const [removing, setRemoving] = useState<string>();
  const { busy, error, run } = useAction();

  const load = () => window.agentBoard.orchestrators.prefabs().then(setLibrary, (failure: unknown) => setLoadError(errorMessage(failure)));
  useEffect(() => void load(), []);

  if (editing !== undefined) {
    return <PrefabEditor prefab={editing} onClose={() => setEditing(undefined)} onSaved={() => void load()} />;
  }
  const remove = (name: string) =>
    run(
      () => window.agentBoard.orchestrators.removePrefab(name),
      () => {
        setRemoving(undefined);
        void load();
      },
    );
  /** Remove, or once asked, the question with its answers. */
  const removeButtons = (name: string) =>
    removing === name ? (
      <>
        <span className="prefab-list-ask">Remove it for good?</span>
        <Button size="sm" variant="danger" loading={busy} onClick={() => remove(name)}>
          Remove
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRemoving(undefined)}>
          Keep
        </Button>
      </>
    ) : (
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(name)}>
        Remove
      </Button>
    );

  return (
    <Dialog
      aria-label="Crew prefabs"
      title="Crew prefabs"
      onClose={onClose}
      footerStart={<Button onClick={() => setEditing(null)}>New prefab</Button>}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {library === undefined ? (
        loadError === undefined ? <Hint>Loading…</Hint> : <ErrorText>{loadError}</ErrorText>
      ) : (
        <ul className="prefab-list" aria-label="Library">
          {library.prefabs.map((prefab) => (
            <li key={prefab.name} className="prefab-list-row">
              <span className="prefab-list-mark" aria-hidden>
                <PrefabIcon icon={prefab.icon} />
              </span>
              <span className="prefab-list-text">
                <b>{prefab.name}</b>
                {prefab.builtIn && <Tag>Built-in</Tag>}
                <span className="prefab-list-sub">{prefab.purpose || prefab.members.map(memberLabel).join(', ')}</span>
              </span>
              <span className="prefab-list-actions">
                <Button size="sm" onClick={() => setEditing(prefab)}>
                  {prefab.builtIn ? 'Copy' : 'Edit'}
                </Button>
                {!prefab.builtIn && removeButtons(prefab.name)}
              </span>
            </li>
          ))}
          {library.unreadable.map((row) => (
            <li key={row.name} className="prefab-list-row">
              <span className="prefab-list-mark" aria-hidden>
                <PrefabIcon icon="crew" />
              </span>
              <span className="prefab-list-text">
                <b>{row.name}</b>
                <span className="prefab-list-sub">Can't be read: {row.reason}</span>
              </span>
              <span className="prefab-list-actions">
                {removeButtons(row.name)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
