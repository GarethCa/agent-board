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
const STATUS_LINE = /^[^\s?•]\S*( \S+)? · \S/;

/** The shortcuts hint Codex draws under its status line, the screen's last line (`← for agents · ? for shortcuts`). */
const SHORTCUTS = /\? for shortcuts/;

/**
 * Whether the visible `lines` of a Codex session's screen, box drawing taken out (`screenLines`), show its composer
 * up, ready for its first prompt: its last `›` line is its composer, not a list's pointer row, the next line with
 * text under it is the status line, and the screen ends there or at the shortcuts hint, with no reply between (a long
 * folder may wrap the status line onto the next). Read from the bottom up, as what Codex shows now is drawn last.
 *
 * A resumed conversation, redrawn before the composer is, has past prompts with the composer's glyph
 * (`› fix the tests`). The line under one is its reply (`• Done · see notes`, never the status line, as it starts with a
 * bullet) or, for a prompt that wraps or spans lines, more of it, which may look like the status line
 * (`tests · then commit`); its reply then comes below, where only the shortcuts hint may be. Left open: a past prompt
 * drawn last, with no reply under it, whose last line looks like the status line.
 */
export function codexComposerUp(lines: string[]): boolean {
  const shown = lines.map((line) => line.trim()).filter((line) => line !== '');
  const prompt = shown.findLastIndex((line) => line.startsWith('›'));
  if (prompt === -1 || POINTED_OPTION.test(shown[prompt]!) || !COMPOSER.test(shown[prompt]!)) return false;
  if (!STATUS_LINE.test(shown[prompt + 1] ?? '')) return false;
  const below = shown.slice(prompt + 2);
  return (below.length === 0 || SHORTCUTS.test(below.at(-1)!)) && !below.some((line) => REPLY_OR_PROMPT.test(line));
}

/** A line that starts a reply (`• Done`) or another prompt: never drawn between the composer and the screen's foot. */
const REPLY_OR_PROMPT = /^[•›]/;

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
