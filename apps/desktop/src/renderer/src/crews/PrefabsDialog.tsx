import { Plus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Hint, Tag } from '../ui';
import { useAction } from '../use-action';
import { RoleIcon } from './icons';
import { memberLabel, prefabWeight } from './prefab-flow';
import { refreshPrefabs, yoursFirst } from './prefab-store';

/** The most member faces a card shows before it says how many more. */
const MAX_FACES = 5;

export interface PrefabsDialogProps {
  onClose(): void;
  /** Opens the prompt box for a crew from the prefab. */
  onStart(prefab: LibraryPrefab): void;
  /** Opens the flow editor: on the prefab, or null for a new one. */
  onEdit(prefab: LibraryPrefab | null): void;
  /** Asks for a `.crew.json` file, to show it whole before it is added. */
  onImport(): void;
  /** What it shows in place of reading the library, and a card asking before it removes, for the gallery. */
  library?: Library;
  asking?: string;
}

interface Library {
  prefabs: readonly LibraryPrefab[];
  unreadable: readonly { name: string; reason: string }[];
}

/** A prefab as a card of the library: its faces, what it is for and how heavy it runs, then what to do with it. */
function PrefabCard({ prefab, children }: { prefab: LibraryPrefab; children: ReactNode }) {
  const more = prefab.members.length - MAX_FACES;
  return (
    <li className={`prefab-card${prefab.builtIn ? '' : ' mine'}`} data-testid="prefab-card">
      <span className="prefab-card-faces" aria-hidden>
        {prefab.members.slice(0, MAX_FACES).map((member) => (
          <span key={member.id} className="prefab-node-bubble small">
            <RoleIcon member={member} />
          </span>
        ))}
        {more > 0 && <span className="prefab-card-more">+{more}</span>}
      </span>
      <span className="prefab-card-name">
        <b>{prefab.name}</b>
      </span>
      <span className="prefab-card-purpose">{prefab.purpose || prefab.members.map(memberLabel).join(', ')}</span>
      <span className="prefab-card-foot">
        <Tag>{prefab.builtIn ? 'Built in' : 'Yours'}</Tag>
        <span className="prefab-card-weight">{prefabWeight(prefab)}</span>
      </span>
      <span className="prefab-card-actions">{children}</span>
    </li>
  );
}

/**
 * The app's crew prefabs, one library for every board, yours first: each a card to start a crew from, to edit (a
 * built-in, as a copy of your own) or remove, with Make a prefab and Import a file. A prefab can't be got back once
 * removed, so Remove asks first, on its card.
 */
export function PrefabsDialog({ onClose, onStart, onEdit, onImport, library: given, asking }: PrefabsDialogProps) {
  const [library, setLibrary] = useState<Library | undefined>(given);
  const [loadError, setLoadError] = useState<string>();
  const [removing, setRemoving] = useState(asking);
  const { busy, error, run } = useAction();

  const load = () => window.agentBoard.orchestrators.prefabs().then(setLibrary, (failure: unknown) => setLoadError(errorMessage(failure)));
  useEffect(() => {
    if (given === undefined) void load();
    // Loaded once as it opens; saving reloads it from the flow it opened.
  }, []);

  const remove = (name: string) =>
    run(
      () => window.agentBoard.orchestrators.removePrefab(name),
      () => {
        setRemoving(undefined);
        void load();
        void refreshPrefabs();
      },
    );
  const removeButtons = (name: string) =>
    removing === name ? (
      <>
        <span className="prefab-card-ask">Remove it for good?</span>
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
      aria-label="Crew library"
      title="Crew library"
      onClose={onClose}
      data-testid="crew-library"
      inline={given !== undefined}
      footerStart={
        <Button variant="ghost" onClick={onImport}>
          Import a file
        </Button>
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {library === undefined ? (
        loadError === undefined ? <Hint>Loading…</Hint> : <ErrorText>{loadError}</ErrorText>
      ) : (
        <ul className="prefab-cards" aria-label="Library">
          {yoursFirst(library.prefabs).map((prefab) => (
            <PrefabCard key={prefab.name} prefab={prefab}>
              <Button size="sm" onClick={() => onStart(prefab)}>
                Start
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(prefab)}>
                {prefab.builtIn ? 'Copy' : 'Edit'}
              </Button>
              {!prefab.builtIn && removeButtons(prefab.name)}
            </PrefabCard>
          ))}
          {library.unreadable.map((row) => (
            <li key={row.name} className="prefab-card" data-testid="prefab-card">
              <span className="prefab-card-name">
                <b>{row.name}</b>
              </span>
              <span className="prefab-card-purpose">Can't be read: {row.reason}</span>
              <span className="prefab-card-actions">{removeButtons(row.name)}</span>
            </li>
          ))}
          <li className="prefab-card-make">
            <button type="button" onClick={() => onEdit(null)}>
              <Plus aria-hidden />
              Make a prefab
              <span>Start blank, or copy one above</span>
            </button>
          </li>
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
