import { readdirSync, readFileSync } from 'node:fs';
import xtermHeadless from '@xterm/headless';
import xtermGraphemes from '@xterm/addon-unicode-graphemes';
import { describe, expect, it } from 'vitest';
import { showsIdlePrompt } from '../src/quiet-turns.ts';
import { visibleLines } from '../src/sessions.ts';
import { readStartupScreen } from '../src/startup-screen.ts';
import { recordingBytes, startupRecordings, type StartupRecording } from './startup-recordings.ts';

/** The recording's bytes drawn on a terminal as the daemon keeps one, read as `screenLines` reads it. */
function replay(recording: StartupRecording): Promise<string[]> {
  const model = new xtermHeadless.Terminal({ cols: recording.cols, rows: recording.rows, allowProposedApi: true });
  model.loadAddon(new xtermGraphemes.UnicodeGraphemesAddon());
  const bytes = readFileSync(recordingBytes(recording));
  return new Promise((resolve) => model.write(bytes, () => resolve(visibleLines(model))));
}

describe("Claude Code's start-up screens, as its terminal drew them", () => {
  it('each have their bytes and what they show, side by side', () => {
    const files = readdirSync(new URL('../../../fixtures/claude/tui/', import.meta.url));
    const named = (extension: string) => files.filter((file) => file.endsWith(extension)).map((file) => file.slice(0, -extension.length)).sort();
    expect(named('.json')).toEqual(named('.bin'));
  });

  it('include a prompt screen and a trust screen', () => {
    expect(startupRecordings.map((recording) => recording.screen)).toEqual(expect.arrayContaining(['prompt', 'trust']));
  });

  for (const recording of startupRecordings.filter((each) => each.screen === 'prompt')) {
    it(`reads ${recording.name} (${recording.version}) as Claude's prompt, ready for a first message`, async () => {
      const lines = await replay(recording);
      expect(readStartupScreen(lines), lines.join('\n')).toEqual({ kind: 'prompt' });
      expect(showsIdlePrompt(lines), lines.join('\n')).toBe(true);
    });
  }

  for (const recording of startupRecordings.filter((each) => each.screen === 'trust')) {
    it(`reads ${recording.name} (${recording.version}) as Claude's trust screen, its pointer on No, exit`, async () => {
      const lines = await replay(recording);
      expect(readStartupScreen(lines), lines.join('\n')).toEqual({ kind: 'trust', on: 'no' });
    });
  }
});
