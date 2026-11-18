// The prefab drafts agents made for the user, as Settings › Prefabs › Drafts lists them and the board opens them. A
// draft is read from the daemon once, and kept current as agents draft and the user deletes. Opening one never saves it.
import { useSyncExternalStore } from 'react';
import type { PrefabDraft } from '@agent-board/daemon/protocol';
import type { PrefabBoardStart } from './PrefabBoard';

/** What Settings lists: the drafts, oldest first, and the ones this release can't read, by id, to delete. */
export interface DraftsKnown {
  drafts: readonly PrefabDraft[];
  unreadable: readonly string[];
  failed: boolean;
}

let known: DraftsKnown = { drafts: [], unreadable: [], failed: false };
const listeners = new Set<() => void>();
let following = false;

const tell = (next: DraftsKnown) => {
  known = next;
  for (const listener of listeners) listener();
};

/** Reads the drafts again, for everyone reading them. */
function refreshDrafts(): Promise<void> {
  return window.agentBoard.orchestrators.drafts().then(
    ({ drafts, unreadable }) => tell({ drafts, unreadable: unreadable.map((each) => each.id), failed: false }),
    () => tell({ ...known, failed: true }),
  );
}

/** The drafts as last read or told. */
export const currentDrafts = (): DraftsKnown => known;

/** Calls `listener` as the drafts change: the first reads them, and follows the daemon's events from then on. */
export const followDrafts = (listener: () => void): (() => void) => {
  if (!following) {
    following = true;
    void refreshDrafts();
    window.agentBoard.orchestrators.onDraft((event) => {
      if (event.type === 'prefabDraft.added') tell({ ...known, drafts: [...known.drafts.filter((each) => each.id !== event.draft.id), event.draft] });
      else tell({ ...known, drafts: known.drafts.filter((each) => each.id !== event.id), unreadable: known.unreadable.filter((id) => id !== event.id) });
    });
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The drafts waiting for the user, kept current. */
export const usePrefabDrafts = (): DraftsKnown => useSyncExternalStore(followDrafts, currentDrafts);

/** What the toast says as an agent drafts one. */
export const draftedMessage = (draft: PrefabDraft): string => `${draft.drafter.name} drafted “${draft.prefab.name}”`;

/** How a draft opens on its prefab's board: unsaved, saving as new, with its banner and what its drafter assumed. */
const draftStart = (draft: PrefabDraft): PrefabBoardStart => ({
  prefab: draft.prefab,
  replaces: null,
  draft: { id: draft.id, drafter: draft.drafter.name, assumptions: draft.assumptions },
});

/** Opens a draft by its id (which closes a drafter started only to draft it), as its board's start. */
export const openDraft = (id: string): Promise<PrefabBoardStart> => window.agentBoard.orchestrators.openDraft(id).then(draftStart);
