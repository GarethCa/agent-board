// What each kind of board item is called, apart from how it is drawn, so code with no React in it can name an item.
import type { BoardItemKind } from '@agent-board/daemon/protocol';

/** Each item kind's name, in lower case, as a sentence uses it. */
export const ITEM_KIND_LABELS: Record<BoardItemKind, string> = {
  sticky: 'sticky note',
  text: 'text',
  shape: 'shape',
  image: 'image',
  link: 'link card',
  issue: 'issue card',
  'agent-note': 'agent note',
  document: 'document',
  plan: 'plan card',
  clock: 'clock',
  steps: 'steps card',
  memory: 'memory',
  queue: 'queue',
  todo: 'to-do list',
  crew: 'crew card',
  stages: 'stage board',
};

/** The kind's name as a row or a heading starts with it: "Sticky note". */
export const itemKindTitle = (kind: BoardItemKind): string => {
  const label = ITEM_KIND_LABELS[kind];
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
};
