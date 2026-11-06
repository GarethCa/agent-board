// The app's crew prefab library as every menu and sheet reads it: menus are built in one go, so they read it as it is
// last known. It is read from the daemon once, and again whenever a prefab is saved or removed, from here or a shell.
import { useMemo, useSyncExternalStore } from 'react';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';

let library: readonly LibraryPrefab[] = [];
let readFailed = false;
const listeners = new Set<() => void>();
let following = false;
/** How long before a library that couldn't be read is read again. */
const RETRY_MS = 5000;

const tell = () => {
  for (const listener of listeners) listener();
};

let retrying: ReturnType<typeof setTimeout> | undefined;

/** Reads the library again, for everyone reading it. One that can't be read stays as it was, and is read again soon, by one timer however many reads failed. */
export function refreshPrefabs(): Promise<void> {
  return window.agentBoard.orchestrators.prefabs().then(
    ({ prefabs }) => {
      library = prefabs;
      readFailed = false;
      tell();
    },
    () => {
      readFailed = true;
      tell();
      retrying ??= setTimeout(() => {
        retrying = undefined;
        void refreshPrefabs();
      }, RETRY_MS);
    },
  );
}

const follow = () => {
  if (following) return;
  following = true;
  void refreshPrefabs();
  window.agentBoard.orchestrators.onLogged(({ entry }) => {
    if (entry.outcome === 'done' && (entry.action === 'save-prefab' || entry.action === 'remove-prefab')) void refreshPrefabs();
  });
};

/** The library as last known, in the order it lists them. Empty until it is first read. */
export const currentPrefabs = (): readonly LibraryPrefab[] => library;

/** Yours first, then the built-ins, each as the library lists them. */
export const yoursFirst = (prefabs: readonly LibraryPrefab[]): LibraryPrefab[] => [...prefabs.filter((prefab) => !prefab.builtIn), ...prefabs.filter((prefab) => prefab.builtIn)];

/** The library as a menu lists it, each group on its way, as last known: yours, then the built-ins, leaving out one that is empty. */
export const crewGroups = (): LibraryPrefab[][] => [currentPrefabs().filter((prefab) => !prefab.builtIn), currentPrefabs().filter((prefab) => prefab.builtIn)].filter((group) => group.length > 0);

const subscribe = (listener: () => void) => {
  follow();
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The library, yours first, kept current. */
export function usePrefabs(): readonly LibraryPrefab[] {
  const known = useSyncExternalStore(subscribe, currentPrefabs);
  return useMemo(() => yoursFirst(known), [known]);
}

/** Whether the library's last read failed: it is being tried again. */
export function usePrefabsFailed(): boolean {
  return useSyncExternalStore(subscribe, () => readFailed);
}
