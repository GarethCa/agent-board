import type { Harness } from '@agent-board/daemon/protocol';
import { isMac } from '../keys';

/**
 * What each harness's TUI reads as "a new line in the message" rather than "send it". xterm sends a plain CR
 * for Enter and Shift+Enter alike, so an agent's terminal sends this for Shift+Enter and Option+Enter instead. ESC CR
 * is Alt+Enter to both: Claude Code takes it as a newline, and Codex binds it (with Ctrl+J and Shift+Enter) to its
 * composer's `insert_newline`, leaving plain Enter to submit.
 */
export const NEWLINE_SEQUENCES: Record<Harness, string> = { claude: '\x1b\r', codex: '\x1b\r' };

/**
 * The sequence to send for `event` in a terminal running `harness`, or undefined to let xterm handle it: Shift+Enter
 * and Option+Enter in an agent's terminal. A plain shell (`harness` null) is a normal terminal, and Enter there is CR.
 */
export function newlineKey(
  harness: Harness | null,
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): string | undefined {
  if (harness === null || event.key !== 'Enter' || event.ctrlKey || event.metaKey) return undefined;
  return event.shiftKey || event.altKey ? NEWLINE_SEQUENCES[harness] : undefined;
}

const MAC_LINE_EDIT: Record<'meta' | 'alt', Partial<Record<string, string>>> = {
  meta: { Backspace: '\x15', ArrowLeft: '\x01', ArrowRight: '\x05' },
  alt: { ArrowLeft: '\x1bb', ArrowRight: '\x1bf' },
};

/**
 * The sequence for a macOS line-editing key, as Terminal.app, iTerm2 and Ghostty send it: ⌘⌫ deletes to the
 * line start (Ctrl-U), ⌘← and ⌘→ go to its start and end (Ctrl-A, Ctrl-E), ⌥← and ⌥→ move by word (ESC b, ESC f).
 * Undefined for any other key, which xterm handles: ⌥⌫ is ESC DEL there already. Undefined for every key off macOS.
 */
export function macLineEditKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  onMac = isMac,
): string | undefined {
  if (!onMac || event.shiftKey || event.ctrlKey || event.metaKey === event.altKey) return undefined;
  return MAC_LINE_EDIT[event.metaKey ? 'meta' : 'alt'][event.key];
}
