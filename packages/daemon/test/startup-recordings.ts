// Claude Code's start-up screens as raw terminal bytes, for tests that read what the real TUI draws.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../../fixtures/claude/tui/', import.meta.url));

/**
 * A start-up screen in `fixtures/claude/tui/`: `<name>.bin`, the raw bytes, and `<name>.json` beside it, with the
 * Claude Code version that drew it, the terminal size it was drawn at, what it shows (`prompt` or `trust`), and whether
 * it was recorded from the real TUI (`scripts/claude-capture/`) or built by hand. `chunks` keeps the pace it was drawn
 * at: each chunk's time from the start in ms and the byte offset it ends at, as the fake harness replays it.
 */
export interface StartupRecording {
  name: string;
  version: string;
  cols: number;
  rows: number;
  screen: 'prompt' | 'trust';
  recorded: boolean;
  chunks?: [number, number][];
}

/**
 * Every start-up screen there, by name: a new recording, made when Claude Code updates, is among them. A `.bin` with no
 * `.json` is left out, for the pairing test to name.
 */
export const startupRecordings: StartupRecording[] = readdirSync(dir)
  .filter((file) => file.endsWith('.bin') && existsSync(join(dir, `${file.slice(0, -'.bin'.length)}.json`)))
  .sort()
  .map((file) => {
    const name = file.slice(0, -'.bin'.length);
    return { name, ...(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Omit<StartupRecording, 'name'>) };
  });

/** The path of `recording`'s bytes. */
export const recordingBytes = (recording: StartupRecording): string => join(dir, `${recording.name}.bin`);

/** Whether version `a` is older than `b`, both `major.minor.patch`. */
const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x![i] !== y![i]) return (x![i] ?? 0) < (y![i] ?? 0);
  return false;
};

/** The prompt screen of the newest Claude Code there, a real recording before a hand-built one. */
export function newestPromptRecording(): StartupRecording {
  const prompts = startupRecordings.filter((each) => each.screen === 'prompt');
  const best = prompts.reduce<StartupRecording | undefined>((top, each) => {
    if (top === undefined || each.recorded !== top.recorded) return top === undefined || each.recorded ? each : top;
    return older(top.version, each.version) ? each : top;
  }, undefined);
  if (best === undefined) throw new Error('no prompt screen in fixtures/claude/tui');
  return best;
}
