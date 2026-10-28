// Reading the Codex TUI's screen as it starts, to type a Codex agent's first prompt once its session is up (ADR-0004).

/** Its composer: the prompt glyph, then what is typed or its placeholder. */
const COMPOSER = /^›(\s|$)/;

/** The pointer row of a startup screen's list (`› 1. Trust and continue`), which looks like its composer. */
const POINTED_OPTION = /^›\s*\d+\.\s/;

/**
 * The status line Codex draws under its composer once its session is up: its model (and reasoning effort) and its
 * folder (`gpt-5.5 high · ~/work/proj`). The composer is drawn while Codex loads, before a folder-trust or hooks
 * review screen may take its place; this line only once every such screen is through.
 */
const STATUS_LINE = /^[^\s?]\S*( \S+)? · \S/;

/**
 * Whether the visible `lines` of a Codex session's screen, box drawing taken out (`screenLines`), show its composer
 * up, ready for its first prompt: its last `›` line is its composer, not a list's pointer row, and the next line with
 * text under it is the status line. Read from the bottom up, as what Codex shows now is drawn last.
 */
export function codexComposerUp(lines: string[]): boolean {
  const shown = lines.map((line) => line.trim()).filter((line) => line !== '');
  const prompt = shown.findLastIndex((line) => line.startsWith('›'));
  if (prompt === -1 || POINTED_OPTION.test(shown[prompt]!) || !COMPOSER.test(shown[prompt]!)) return false;
  return STATUS_LINE.test(shown[prompt + 1] ?? '');
}

/** How long a Codex session's output must stay quiet before its screen is read for its composer. */
const COMPOSER_QUIET_MS = 300;

/**
 * Watches starting Codex sessions' screens for their composer up (`codexComposerUp`): each is read once its output
 * has stayed quiet for `COMPOSER_QUIET_MS` (Codex has drawn what it draws for now), and `up` hears of each one found.
 * It remembers each session it has seen up: before then, what the user types answers a startup screen, not its composer.
 */
export function createComposerWatch(screenLines: (sessionId: string) => Promise<string[] | null>, up: (sessionId: string) => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const seenUp = new Set<string>();
  const read = (sessionId: string) => {
    timers.delete(sessionId);
    screenLines(sessionId)
      .then((lines) => {
        if (lines === null || !codexComposerUp(lines)) return;
        seenUp.add(sessionId);
        up(sessionId);
      })
      .catch(() => {});
  };
  return {
    /** The watched session printed: its screen is read once it goes quiet. */
    outputSeen(sessionId: string) {
      clearTimeout(timers.get(sessionId));
      timers.set(sessionId, setTimeout(() => read(sessionId), COMPOSER_QUIET_MS).unref());
    },
    /** Whether the session's composer has been seen up since it was first watched. */
    seenUp: (sessionId: string) => seenUp.has(sessionId),
    /** Stops watching the session: its first prompt is settled. */
    forget(sessionId: string) {
      clearTimeout(timers.get(sessionId));
      timers.delete(sessionId);
      seenUp.delete(sessionId);
    },
  };
}
