import { useState } from 'react';
import { ChevronRight, Copy, Lock, MessageSquareText, MoreHorizontal, Pencil, Plus, Upload } from 'lucide-react';
import type { LibraryPrefab, PrefabMember } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { isNewPrefab } from '../board/menu-model';
import { Badge, Button, ErrorText, IconButton, Menu, Truncate } from '../ui';
import { editStart } from './CrewFlow';
import { CrewFaces, PrefabIcon } from './icons';
import { libraryBoard } from './prefab-board';
import type { PrefabBoardStart } from './PrefabBoard';
import { usePrefabDrafts } from './prefab-drafts';
import { refreshPrefabs, usePrefabs, usePrefabsFailed } from './prefab-store';

/** Opens `start` on its own board, in the board's window, which comes to the front. */
const openBoard = (start: PrefabBoardStart) => void window.agentBoard.windows.requestBoard({ kind: 'prefab', prefab: start.prefab, replaces: start.replaces });

/** The one your prompt starts first, then the rest. */
const promptFirst = (members: readonly PrefabMember[]): PrefabMember[] => {
  const first = members.find((member) => member.starts === 'prompt');
  return first === undefined ? [...members] : [first, ...members.filter((member) => member !== first)];
};

/** A prefab's shape at a glance: your prompt ▸ the agent it starts ▸ the rest. */
function PrefabShape({ members }: { members: readonly PrefabMember[] }) {
  const [first, ...rest] = promptFirst(members);
  return (
    <span className="prefabs-shape" aria-hidden>
      <span className="prefabs-shape-prompt" />
      {first !== undefined && (
        <>
          <ChevronRight />
          <CrewFaces members={[first]} />
        </>
      )}
      {rest.length > 0 && (
        <>
          <ChevronRight />
          <CrewFaces members={rest} most={3} />
        </>
      )}
    </span>
  );
}

/**
 * Settings › Prefabs: your crew prefabs, newest first, each to open on its own board, duplicate, export as a file or
 * delete (which asks first, in its row, as it can't be got back); the built-ins folded under them, to duplicate; and
 * + New prefab, Describe a crew… and Import a file… at the top, and the drafts agents made under yours. Every one opens
 * on its board in the board's window.
 */
export function PrefabsSetting() {
  const prefabs = usePrefabs();
  const failed = usePrefabsFailed();
  const [asking, setAsking] = useState<string>();
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState(false);
  const now = Date.now();
  const yours = prefabs.filter((prefab) => !prefab.builtIn).sort((a, b) => (b.editedAt ?? '').localeCompare(a.editedAt ?? ''));
  const builtIn = prefabs.filter((prefab) => prefab.builtIn);

  const importFile = () => {
    setError(undefined);
    window.agentBoard.orchestrators.importPrefab().then(
      (imported) => imported !== null && openBoard(editStart(null, imported)),
      (failure: unknown) => setError(`Could not import it: ${errorMessage(failure)}`),
    );
  };
  const exportFile = (prefab: LibraryPrefab) => {
    setError(undefined);
    window.agentBoard.orchestrators.exportPrefab(prefab).catch((failure: unknown) => setError(`Could not export it: ${errorMessage(failure)}`));
  };
  const remove = (name: string) => {
    setError(undefined);
    window.agentBoard.orchestrators.removePrefab(name).then(
      () => {
        setAsking(undefined);
        void refreshPrefabs();
      },
      (failure: unknown) => setError(`Could not delete it: ${errorMessage(failure)}`),
    );
  };

  return (
    <div className="prefabs-setting" data-testid="prefabs-setting">
      <div className="prefabs-setting-head">
        <span className="prefabs-setting-say">Prefabs are crews you start in one go. Each opens on its own board.</span>
        <Button size="sm" variant="ghost" onClick={importFile}>
          <Upload aria-hidden />
          Import a file…
        </Button>
        <Button size="sm" variant="ghost" data-testid="prefabs-describe" onClick={() => void window.agentBoard.windows.requestBoard({ kind: 'crew', prefab: null, zoneId: null, describe: true })}>
          <MessageSquareText aria-hidden />
          Describe a crew…
        </Button>
        <Button size="sm" variant="primary" onClick={() => openBoard(editStart(null))} data-testid="prefabs-new">
          <Plus aria-hidden />
          New prefab
        </Button>
      </div>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
      {failed && <ErrorText>Could not read your prefabs. Trying again…</ErrorText>}
      {yours.length === 0 ? (
        <p className="prefabs-setting-none">None yet. Make one, or save one from an agent’s tile with Copy ▸ Save as prefab… in its menu.</p>
      ) : (
        <ul className="prefabs-list" aria-label="Your prefabs">
          {yours.map((prefab) =>
            asking === prefab.name ? (
              <li key={prefab.name} className="prefabs-row" data-asking>
                <span className="prefabs-ask">
                  Delete <b>{prefab.name}</b>? It can’t be got back.
                </span>
                <span className="prefabs-row-actions" data-shown>
                  <Button size="sm" variant="ghost" onClick={() => setAsking(undefined)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(prefab.name)} data-testid="prefabs-delete">
                    Delete
                  </Button>
                </span>
              </li>
            ) : (
              <li key={prefab.name} className="prefabs-row" data-testid="prefabs-row">
                <span className="prefabs-icon">
                  <PrefabIcon icon={prefab.icon} />
                </span>
                <span className="prefabs-words">
                  <span className="prefabs-name">
                    <Truncate text={prefab.name} />
                    {isNewPrefab(prefab, now) && <Badge tone="neutral">new</Badge>}
                  </span>
                  {prefab.purpose !== '' && (
                    <span className="prefabs-purpose">
                      <Truncate text={prefab.purpose} />
                    </span>
                  )}
                </span>
                <PrefabShape members={prefab.members} />
                <span className="prefabs-row-actions">
                  <Button size="sm" variant="primary" onClick={() => openBoard(libraryBoard(prefab))} data-testid="prefabs-open">
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openBoard(libraryBoard(prefab, true))}>
                    Duplicate
                  </Button>
                  <Menu
                    align="end"
                    entries={[
                      { label: 'Export a file…', onSelect: () => exportFile(prefab) },
                      { label: 'Delete…', danger: true, onSelect: () => setAsking(prefab.name) },
                    ]}
                  >
                    <IconButton size="sm" variant="ghost" aria-label={`More for ${prefab.name}`} icon={<MoreHorizontal aria-hidden />} />
                  </Menu>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      <PrefabDrafts />
      {builtIn.length > 0 && (
        <div className="prefabs-built">
          <button type="button" className="prefabs-built-head" aria-expanded={shown} onClick={() => setShown(!shown)}>
            <ChevronRight aria-hidden data-open={shown || undefined} />
            Built in · {builtIn.length}
          </button>
          {shown && (
            <ul className="prefabs-list" aria-label="Built in">
              {builtIn.map((prefab) => (
                <li key={prefab.name} className="prefabs-row" data-built-in>
                  <span className="prefabs-icon">
                    <PrefabIcon icon={prefab.icon} />
                  </span>
                  <span className="prefabs-words">
                    <span className="prefabs-name">
                      <Truncate text={prefab.name} />
                    </span>
                    <span className="prefabs-purpose">
                      <Lock aria-hidden />
                      <Truncate text="Built in: duplicate it to change it" />
                    </span>
                  </span>
                  <PrefabShape members={prefab.members} />
                  <span className="prefabs-row-actions" data-shown>
                    <Button size="sm" variant="ghost" onClick={() => openBoard(libraryBoard(prefab, true))}>
                      <Copy aria-hidden />
                      Duplicate
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Settings › Prefabs › Drafts: the prefabs agents drafted that the user hasn't saved or deleted, oldest first, each to
 * open on its board in the board's window or delete. None is in the library until it is saved from its board.
 */
function PrefabDrafts() {
  const { drafts, unreadable, failed } = usePrefabDrafts();
  const [error, setError] = useState<string>();
  if (drafts.length === 0 && unreadable.length === 0 && !failed) return null;

  const remove = (id: string) => {
    setError(undefined);
    window.agentBoard.orchestrators.removeDraft(id).catch((failure: unknown) => setError(`Could not delete it: ${errorMessage(failure)}`));
  };

  return (
    <section className="prefabs-drafts" aria-label="Drafts" data-testid="prefabs-drafts">
      <h3 className="prefabs-drafts-head">Drafts · {drafts.length}</h3>
      <p className="prefabs-setting-say">Drafted by agents, waiting for you. None is in your prefabs until you save it from its board.</p>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
      {failed && <ErrorText>Could not read the drafts.</ErrorText>}
      <ul className="prefabs-list" aria-label="Drafts">
        {drafts.map((draft) => (
          <li key={draft.id} className="prefabs-row" data-testid="prefabs-draft">
            <span className="prefabs-icon">
              <Pencil aria-hidden />
            </span>
            <span className="prefabs-words">
              <span className="prefabs-name">
                <Truncate text={draft.prefab.name} />
              </span>
              <span className="prefabs-purpose">
                <Truncate text={`Drafted by ${draft.drafter.name}`} />
              </span>
            </span>
            <PrefabShape members={draft.prefab.members} />
            <span className="prefabs-row-actions" data-shown>
              <Button size="sm" variant="primary" data-testid="prefabs-draft-open" onClick={() => void window.agentBoard.windows.requestBoard({ kind: 'prefabDraft', id: draft.id })}>
                Open
              </Button>
              <Button size="sm" variant="ghost" data-testid="prefabs-draft-delete" onClick={() => remove(draft.id)}>
                Delete
              </Button>
            </span>
          </li>
        ))}
        {unreadable.map((id) => (
          <li key={id} className="prefabs-row" data-testid="prefabs-draft-unreadable">
            <span className="prefabs-icon">
              <Pencil aria-hidden />
            </span>
            <span className="prefabs-words">
              <span className="prefabs-name">A draft this version can’t read</span>
              <span className="prefabs-purpose">Made by a later version of the app, or changed outside it</span>
            </span>
            <span className="prefabs-row-actions" data-shown>
              <Button size="sm" variant="ghost" onClick={() => remove(id)}>
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
