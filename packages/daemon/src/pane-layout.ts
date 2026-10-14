// A shell tile's panes, tmux-style: a binary tree of splits whose leaves are sessions. Pure, with no Node imports, so
// the daemon (which stores and changes it) and the app (which draws it) share one definition.

/** `horizontal` puts the panes side by side (tmux's `split-window -h`), `vertical` one above the other. */
export type SplitDirection = 'horizontal' | 'vertical';

/**
 * A binary tree of splits, tmux-style, whose leaves are `Leaf`s: a shell's panes (`PaneLayout`), or a session window's
 * panes (`WindowLayout`, window-layout.ts). One shape, so resizing, reading back and laying out are written once.
 */
export type SplitTree<Leaf> = Leaf | Split<Leaf>;

export interface Split<Leaf> {
  type: 'split';
  /** Names the split, so a resize can say which one. */
  id: string;
  direction: SplitDirection;
  /** The share of the split's length the first side gets. */
  ratio: number;
  first: SplitTree<Leaf>;
  second: SplitTree<Leaf>;
}

/** A leaf of a split tree: anything but a split. */
type Leaf = { type: 'pane' };

export type PaneLayout = SplitTree<{
  type: 'pane';
  sessionId: string;
  /** The user's label for the pane, shown in its header; the shell's name stands in without. */
  name?: string;
}>;

/** How far a divider can be pushed: both panes stay big enough to use. */
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

/** The sessions in the layout, first pane first. */
export function paneIds(layout: PaneLayout): string[] {
  return layout.type === 'pane' ? [layout.sessionId] : [...paneIds(layout.first), ...paneIds(layout.second)];
}

/** Splits the pane `sessionId` in two, the new pane `newSessionId` second. */
export function splitPane(
  layout: PaneLayout,
  sessionId: string,
  direction: SplitDirection,
  newSessionId: string,
  splitId: string,
): PaneLayout {
  if (!paneIds(layout).includes(sessionId)) throw new Error(`no pane ${sessionId}`);
  const walk = (node: PaneLayout): PaneLayout => {
    if (node.type === 'pane') {
      if (node.sessionId !== sessionId) return node;
      return { type: 'split', id: splitId, direction, ratio: 0.5, first: node, second: { type: 'pane', sessionId: newSessionId } };
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  return walk(layout);
}

/** Removes the pane; its sibling takes the place of their split. Null when it was the only pane. */
export function removePane(layout: PaneLayout, sessionId: string): PaneLayout | null {
  if (layout.type === 'pane') return layout.sessionId === sessionId ? null : layout;
  const first = removePane(layout.first, sessionId);
  const second = removePane(layout.second, sessionId);
  if (first === null) return second;
  if (second === null) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/**
 * The pane to focus when `sessionId` closes: the one beside it in the sibling that takes its space, as tmux does.
 * Undefined when it is the only pane, or not in the layout.
 */
export function neighbourOf(layout: PaneLayout, sessionId: string): string | undefined {
  if (layout.type === 'pane') return undefined;
  const { first, second } = layout;
  if (first.type === 'pane' && first.sessionId === sessionId) return paneIds(second)[0];
  if (second.type === 'pane' && second.sessionId === sessionId) return paneIds(first).at(-1);
  return neighbourOf(first, sessionId) ?? neighbourOf(second, sessionId);
}

/** The label the user gave the pane, if any. */
export function paneName(layout: PaneLayout, sessionId: string): string | undefined {
  if (layout.type === 'pane') return layout.sessionId === sessionId ? layout.name : undefined;
  return paneName(layout.first, sessionId) ?? paneName(layout.second, sessionId);
}

/** Labels the pane, or takes its label off with an empty `name`. */
export function setPaneName(layout: PaneLayout, sessionId: string, name: string): PaneLayout {
  if (!paneIds(layout).includes(sessionId)) throw new Error(`no pane ${sessionId}`);
  const walk = (node: PaneLayout): PaneLayout => {
    if (node.type === 'split') return { ...node, first: walk(node.first), second: walk(node.second) };
    if (node.sessionId !== sessionId) return node;
    return name === '' ? { type: 'pane', sessionId } : { type: 'pane', sessionId, name };
  };
  return walk(layout);
}

/** Moves a split's divider, to somewhere both sides stay usable. */
export function setSplitRatio<L extends Leaf>(layout: SplitTree<L>, splitId: string, ratio: number): SplitTree<L> {
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  let found = false;
  const walk = (node: SplitTree<L>): SplitTree<L> => {
    if (node.type !== 'split') return node;
    if (node.id === splitId) {
      found = true;
      return { ...node, ratio: clamped };
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  const result = walk(layout);
  if (!found) throw new Error(`no split ${splitId}`);
  return result;
}

/**
 * A split tree read back from storage or the wire, each leaf by `leaf` (undefined for one that isn't); throws `bad()`
 * for anything that isn't one.
 */
export function parseSplitTree<L>(value: unknown, leaf: (node: Record<string, unknown>) => L | undefined, bad: () => Error): SplitTree<L> {
  if (typeof value !== 'object' || value === null) throw bad();
  const node = value as Record<string, unknown>;
  if (
    node.type === 'split' &&
    typeof node.id === 'string' &&
    (node.direction === 'horizontal' || node.direction === 'vertical') &&
    typeof node.ratio === 'number' &&
    node.ratio >= MIN_SPLIT_RATIO &&
    node.ratio <= MAX_SPLIT_RATIO
  ) {
    return { type: 'split', id: node.id, direction: node.direction, ratio: node.ratio, first: parseSplitTree(node.first, leaf, bad), second: parseSplitTree(node.second, leaf, bad) };
  }
  const parsed = leaf(node);
  if (parsed === undefined) throw bad();
  return parsed;
}

/** A layout read back from storage or the wire; throws if it isn't one. */
export function parsePaneLayout(value: unknown): PaneLayout {
  const bad = () => new Error(`not a pane layout: ${JSON.stringify(value)?.slice(0, 200)}`);
  return parseSplitTree(
    value,
    (node) => {
      if (node.type !== 'pane' || typeof node.sessionId !== 'string') return undefined;
      return typeof node.name === 'string' && node.name !== '' ? { type: 'pane', sessionId: node.sessionId, name: node.name } : { type: 'pane', sessionId: node.sessionId };
    },
    bad,
  );
}
