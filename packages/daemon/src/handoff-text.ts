/** Control characters, C0 and C1, but for the tab and line breaks, which become spaces. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** `text` with no control characters, on one line. */
const plain = (text: string) => text.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();

/**
 * What agent B is typed when agent `from` hands it `text`, its payload `name` (`final message`, `plan.md`): another
 * agent's words, not the user's, so they say where they came from, can't start as a TUI command (`/` a slash command,
 * `!` a shell command in B's worktree), and carry no control character to drive B's terminal (an escape sequence, ^C,
 * ^U). One line, as a typed prompt must be.
 */
export function handoffLine(from: string, name: string, text: string): string {
  return `Hand-off from ${plain(from)} (its ${plain(name)}): ${plain(text)}`;
}
