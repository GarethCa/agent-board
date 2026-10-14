import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RecentFolder } from '@agent-board/daemon/protocol';
import { FolderGit2 } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { folderLabel } from './folders';

/**
 * The folders zones and agents were made for, most recently first, loaded once: for the repo picker and a group's
 * default repo. `onLoaded` hears them as they arrive.
 */
export function useRecentFolders(onLoaded?: (folders: RecentFolder[]) => void): { folders?: RecentFolder[]; error?: string } {
  const [loaded, setLoaded] = useState<{ folders?: RecentFolder[]; error?: string }>({});
  const heard = useRef(onLoaded);
  heard.current = onLoaded;
  // Loaded once, when the list opens.
  useEffect(() => {
    let cancelled = false;
    window.agentBoard.zones.recentFolders().then(
      (folders) => {
        if (cancelled) return;
        setLoaded({ folders });
        heard.current?.(folders);
      },
      (failure: unknown) => cancelled || setLoaded({ error: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return loaded;
}

/**
 * A pickable row of a list of folders: a click or Space picks it, ⏎ picks it and, once it is picked, submits the form
 * it is in.
 */
export function FolderRow({ picked, onPick, children }: { picked: boolean; onPick(): void; children: ReactNode }) {
  return (
    <li
      className="add-zone-row"
      role="option"
      aria-selected={picked}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (event.key === 'Enter' && picked) event.currentTarget.closest('form')?.requestSubmit();
        else onPick();
      }}
    >
      {children}
    </li>
  );
}

/** A folder in a list: its name, then its path and branch. */
export function FolderLine({ path, branch }: { path: string; branch: string | null }) {
  return (
    <>
      <FolderGit2 className="add-zone-row-icon" />
      <span className="add-zone-row-main">
        <span className="add-zone-row-title">{folderLabel(path, undefined)}</span>
        <span className="add-zone-row-detail add-zone-mono">
          {path}
          {branch !== null && ` · ${branch}`}
        </span>
      </span>
    </>
  );
}
