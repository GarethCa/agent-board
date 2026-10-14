/** What a key does in the composer: sends the message, makes a new line in it, or nothing of the composer's own. */
export type ComposerKey = 'send' | 'newline' | undefined;

/**
 * Enter sends; Shift+Enter and Option+Enter make a new line, as in an agent's terminal. An Enter that ends an
 * input method's composition only ends it.
 */
export function composerKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing'>): ComposerKey {
  if (event.key !== 'Enter' || event.isComposing || event.metaKey || event.ctrlKey) return undefined;
  return event.shiftKey || event.altKey ? 'newline' : 'send';
}

/** `text` with `insert` in place of `start`…`end`, a space between it and a word either side, and the caret after it. */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = after === '' || /^\s/.test(after) ? '' : ' ';
  const head = `${before}${lead}${insert}`;
  return { text: `${head}${trail}${after}`, caret: head.length };
}

/** Characters a shell reads specially: whitespace, quotes, its operators, globs and comments. */
const SHELL_SPECIAL = /[\s'"`\\$!&;|<>()*?[\]#{}]/g;

/**
 * A file's path as a terminal pastes a dropped file: each character a shell would read specially (a space, as in
 * `Application Support`) escaped with a backslash, so the harness reads it as one path. Letters of any script stay.
 */
export function droppedPath(path: string): string {
  return path.replace(SHELL_SPECIAL, (character) => `\\${character}`);
}
