import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { spineJoined, spineViewKey } from '@agent-board/daemon/zone-clean-up';
import { isZone, type BoardNode } from './tiles';

/** How long after a Spine zone changes its state is read again: the daemon saves it last, once the tiles are laid out. */
const READ_AFTER_MS = 600;

/**
 * The tiles the user started that joined a Spine zone's bands, of every Spine zone on the board, as their Spine state
 * says: Move to Done folds only those of the user's own. Read again a little after a Spine zone's tiles placed by hand,
 * or the board's agents, change.
 */
export function useSpineJoined(nodes: readonly BoardNode[], agentCount: number): RefObject<ReadonlySet<string>> {
  const joined = useRef<ReadonlySet<string>>(new Set());
  const spineZones = useMemo(
    () =>
      nodes
        .filter(isZone)
        .filter((node) => node.data.zone.layoutRule === 'spine')
        .map((node) => [node.data.zone.id, ...node.data.zone.handPlaced].join(' '))
        .join('\n'),
    [nodes],
  );
  useEffect(() => {
    let live = true;
    const ids = spineZones === '' ? [] : spineZones.split('\n').map((line) => line.split(' ')[0]!);
    const timer = setTimeout(() => {
      void Promise.all(ids.map((id) => window.agentBoard.view.get(spineViewKey(id)).then(spineJoined, () => []))).then((lists) => {
        if (live) joined.current = new Set(lists.flat());
      });
    }, READ_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [spineZones, agentCount]);
  return joined;
}
