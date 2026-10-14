// A shell tile's panes, tmux-style: a binary tree of splits whose leaves are sessions. Pure, with no Node imports, so
// the daemon (which stores and changes it) and the app (which draws it) share one definition.

/** `horizontal` puts the panes side by side (tmux's `split-window -h`), `vertical` one above the other. */
export type SplitDirection = 'horizontal' | 'vertical';

export type PaneLayout =
  | {
      type: 'pane';
      sessionId: string;
      /** The user's label for the pane, shown in its header; the shell's name stands in without. */
      name?: string;
    }
  | {
      type: 'split';
      /** Names the split, so a resize can say which one. */
      id: string;
      direction: SplitDirection;
      /** The share of the split's length the first pane gets. */
      ratio: number;
      first: PaneLayout;
      second: PaneLayout;
    };

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

/** Moves a split's divider, to somewhere both panes stay usable. */
export function setSplitRatio(layout: PaneLayout, splitId: string, ratio: number): PaneLayout {
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  let found = false;
  const walk = (node: PaneLayout): PaneLayout => {
    if (node.type === 'pane') return node;
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

/** A layout read back from storage or the wire; throws if it isn't one. */
export function parsePaneLayout(value: unknown): PaneLayout {
  const bad = () => new Error(`not a pane layout: ${JSON.stringify(value)?.slice(0, 200)}`);
  if (typeof value !== 'object' || value === null) throw bad();
  const node = value as Record<string, unknown>;
  if (node.type === 'pane' && typeof node.sessionId === 'string') {
    return typeof node.name === 'string' && node.name !== ''
      ? { type: 'pane', sessionId: node.sessionId, name: node.name }
      : { type: 'pane', sessionId: node.sessionId };
  }
  if (
    node.type === 'split' &&
    typeof node.id === 'string' &&
    (node.direction === 'horizontal' || node.direction === 'vertical') &&
    typeof node.ratio === 'number' &&
    node.ratio >= MIN_SPLIT_RATIO &&
    node.ratio <= MAX_SPLIT_RATIO
  ) {
    return { type: 'split', id: node.id, direction: node.direction, ratio: node.ratio, first: parsePaneLayout(node.first), second: parsePaneLayout(node.second) };
  }
  throw bad();
}
