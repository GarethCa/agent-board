import { describe, expect, it } from 'vitest';
import { drawPromptBox, drawRateLimitMenu, drawTrustScreen, rateLimitMenuRows } from '@agent-board/fake-harness';
import { answerTrustScreen, readStartupScreen, screenTail } from '../src/startup-screen.ts';

/** A screen's lines as `screenLines` reads them: box drawing taken out, runs of spaces joined. */
const shown = (lines: string[]) => lines.map((line) => line.replace(/[─-╿]/g, ' ').replace(/\s+/g, ' ').trim());

/**
 * Claude Code 2.1.312's trust screen, started with no prompt in a folder it had never opened (120 columns), as
 * `screenLines` reads it: its path wraps, and its rules are taken out.
 */
const RECORDED_TRUST = [
  '',
  'Accessing workspace:',
  '',
  '/private/tmp/scratchpad/a-long-folder-name-that-wraps-past-the-edge-of-the-terminal-at-one-hundred-and-twenty-colum',
  'ns/trustprobe.bA5w',
  '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  "project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  'Security guide',
  '',
  '❯ No, exit',
  'Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
];

/** The same screen after Down. */
const RECORDED_TRUST_DOWN = RECORDED_TRUST.map((line) => (line === '❯ No, exit' ? 'No, exit' : line === 'Yes, I trust this folder' ? '❯ Yes, I trust this folder' : line));

/** Claude Code 2.1.312 at its empty prompt in a trusted folder, as `screenLines` reads it. */
const RECORDED_PROMPT = [
  '▐▛███▛█ Claude Code v2.1.312',
  '▝▜██████▀ Opus 5.5 · Claude Max',
  '▝▝ ▝▝ ~/Projects',
  '◐ medium · /effort',
  '',
  '❯ Try "refactor <filepath>"',
  '',
  '⚠ Transcript saving is off',
  '⏵⏵ auto mode on (shift+tab to cycle)',
];

describe('readStartupScreen', () => {
  it("reads Claude's recorded trust screen, and the row its pointer is on", () => {
    expect(readStartupScreen(RECORDED_TRUST)).toEqual({ kind: 'trust', on: 'no' });
    expect(readStartupScreen(RECORDED_TRUST_DOWN)).toEqual({ kind: 'trust', on: 'yes' });
  });

  it("reads the fake harness's trust screen as the recorded one", () => {
    expect(readStartupScreen(shown(drawTrustScreen('/work/repo')))).toEqual({ kind: 'trust', on: 'no' });
    expect(readStartupScreen(shown(drawTrustScreen('/work/repo', 'yes')))).toEqual({ kind: 'trust', on: 'yes' });
  });

  it("reads an older build's trust screen, its rows numbered", () => {
    expect(readStartupScreen(['Do you trust the files in this folder?', '/work/repo', '❯ 1. Yes, proceed', '2. No, exit'])).toEqual({ kind: 'trust', on: 'yes' });
    expect(readStartupScreen(['Do you trust the files in this folder?', '1. Yes, proceed', '❯ 2. No, exit'])).toEqual({ kind: 'trust', on: 'no' });
  });

  it('reads the trust screen with no pointer row seen as on neither row', () => {
    expect(readStartupScreen(['Quick safety check: Is this a project you created or one you trust?', 'Security guide'])).toEqual({ kind: 'trust', on: null });
  });

  it("reads Claude's recorded prompt, holding its placeholder, and the fake harness's", () => {
    expect(readStartupScreen(RECORDED_PROMPT)).toEqual({ kind: 'prompt' });
    expect(readStartupScreen(shown(drawPromptBox()))).toEqual({ kind: 'prompt' });
  });

  it('never reads another screen with a No, exit row as the trust screen', () => {
    expect(readStartupScreen(['Use this API key?', '', '❯ No, exit', 'Yes, use it', '', 'Enter to confirm · Esc to cancel'])).toEqual({ kind: 'other' });
    expect(readStartupScreen(['❯ No, exit'])).toEqual({ kind: 'other' });
  });

  it("never reads a menu's pointer row as the prompt", () => {
    expect(readStartupScreen(shown(drawRateLimitMenu(rateLimitMenuRows('stop-first'))))).toEqual({ kind: 'other' });
    expect(readStartupScreen(['Choose the text style', '', '❯ 1. Dark mode', '2. Light mode', ''])).toEqual({ kind: 'other' });
  });

  it('reads a screen with neither as something else', () => {
    expect(readStartupScreen(['Welcome to Claude Code', 'Press Enter to continue'])).toEqual({ kind: 'other' });
    expect(readStartupScreen([])).toEqual({ kind: 'other' });
  });
});

describe('screenTail', () => {
  it("joins the screen's last lines with text, its blank ones left out", () => {
    expect(screenTail(['a', '', 'b', 'c', '', 'd', ''])).toBe('b · c · d');
    expect(screenTail(['only'], 3)).toBe('only');
    expect(screenTail(['', ''])).toBe('');
  });
});

/** A terminal showing `screens` in turn, each read taking the next (the last stays), recording what is written. */
function terminalShowing(...screens: (string[] | null)[]) {
  const writes: string[] = [];
  let read = 0;
  const terminal = {
    screen: async () => screens[Math.min(read++, screens.length - 1)]!,
    write: (data: string) => void writes.push(data),
    wait: async () => {},
  };
  return { terminal, writes };
}

describe('answerTrustScreen', () => {
  it('moves the pointer down to the yes row, and presses Enter only once it is seen there', async () => {
    const { terminal, writes } = terminalShowing(RECORDED_TRUST, RECORDED_TRUST, RECORDED_TRUST_DOWN);
    expect(await answerTrustScreen(terminal)).toBeUndefined();
    expect(writes).toEqual(['\x1b[B', '\r']);
  });

  it('presses only Enter when the pointer is on the yes row already', async () => {
    const { terminal, writes } = terminalShowing(RECORDED_TRUST_DOWN);
    expect(await answerTrustScreen(terminal)).toBeUndefined();
    expect(writes).toEqual(['\r']);
  });

  it('never presses Enter while the pointer is not seen on the yes row', async () => {
    const { terminal, writes } = terminalShowing(RECORDED_TRUST);
    expect(await answerTrustScreen(terminal)).toBe('pointer');
    expect(writes).toEqual(['\x1b[B']);

    const unseen = terminalShowing(['Quick safety check: Is this a project you created or one you trust?']);
    expect(await answerTrustScreen(unseen.terminal)).toBe('pointer');
    expect(unseen.writes).toEqual([]);
  });

  it('types nothing at a screen that is not the trust screen, or a terminal that is gone', async () => {
    for (const screen of [RECORDED_PROMPT, null]) {
      const { terminal, writes } = terminalShowing(screen);
      expect(await answerTrustScreen(terminal)).toBe('not-trust');
      expect(writes).toEqual([]);
    }
  });
});
