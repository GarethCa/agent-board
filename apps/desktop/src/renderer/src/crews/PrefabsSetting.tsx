import { useState } from 'react';
import { ChevronRight, Copy, Lock, MoreHorizontal, Plus, Upload } from 'lucide-react';
import type { LibraryPrefab, PrefabMember } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { isNewPrefab } from '../board/menu-model';
import { Badge, Button, ErrorText, IconButton, Menu } from '../ui';
import { editStart } from './CrewFlow';
import { CrewFaces, PrefabIcon } from './icons';
import { libraryBoard } from './prefab-board';
import type { PrefabBoardStart } from './PrefabBoard';
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
 * + New prefab and Import a file… at the top. Every one opens on its board in the board's window.
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
                    {prefab.name}
                    {isNewPrefab(prefab, now) && <Badge tone="neutral">new</Badge>}
                  </span>
                  {prefab.purpose !== '' && <span className="prefabs-purpose">{prefab.purpose}</span>}
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
                    <span className="prefabs-name">{prefab.name}</span>
                    <span className="prefabs-purpose">
                      <Lock aria-hidden />
                      Built in: duplicate it to change it
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
