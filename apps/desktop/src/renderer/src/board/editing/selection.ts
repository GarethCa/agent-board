/**
 * The selected nodes (`all`) and those that move on their own (`top`): not what is in a
 * zone that is selected too, which goes with it.
 */
export function selectedNodes<N extends { id: string; selected?: boolean; parentId?: string }>(nodes: Iterable<N>): { all: N[]; top: N[] } {
  const all = [...nodes].filter((node) => node.selected === true);
  const ids = new Set(all.map((node) => node.id));
  return { all, top: all.filter((node) => node.parentId === undefined || !ids.has(node.parentId)) };
}
