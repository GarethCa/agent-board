import { useCallback, useEffect, useMemo, useState } from 'react';

/** How long a rename request waits for its tile to open its field before it lapses, ms. */
const RENAME_REQUEST_MS = 250;

/**
 * The board's side of `RenameRequestContext`: the tile F2 or the context menu asked to rename, which the tile asked
 * takes up as it opens its name field (`useRenameRequest`).
 */
export function useRenameRequests() {
  /** The tile (node id) F2 or the context menu asked to rename, until it opens its field. */
  const [renameRequest, setRenameRequest] = useState<string>();
  const renameRequests = useMemo(() => ({ nodeId: renameRequest, done: () => setRenameRequest(undefined) }), [renameRequest]);
  // A tile not drawn (off screen, with only visible elements rendered) never answers: drop the ask rather than let it
  // open the field whenever the tile scrolls into view.
  useEffect(() => {
    if (renameRequest === undefined) return;
    const timer = setTimeout(() => setRenameRequest(undefined), RENAME_REQUEST_MS);
    return () => clearTimeout(timer);
  }, [renameRequest]);
  /** Asks the tile `nodeId` to open its name field. */
  const requestRename = useCallback((nodeId: string) => setRenameRequest(nodeId), []);
  return { renameRequest, renameRequests, requestRename };
}
