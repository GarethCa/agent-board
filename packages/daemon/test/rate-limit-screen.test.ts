import { describe, expect, it } from 'vitest';
import { drawRateLimitMenu, rateLimitMenuRows, RATE_LIMIT_CREDITS_ROW, RATE_LIMIT_STOP_ROW, RATE_LIMIT_UPGRADE_ROW } from '@agent-board/fake-harness';
import { readRateLimitScreen } from '../src/rate-limit-screen.ts';

/** A screen's lines as `screenLines` reads them: box drawing taken out. */
const shown = (lines: string[]) => lines.map((line) => line.replace(/[─-╿]/g, ' ').trim());

describe('readRateLimitScreen', () => {
  it('reads the menu in either order of its rows', () => {
    expect(readRateLimitScreen(shown(['API Error: 429', ...drawRateLimitMenu(rateLimitMenuRows('stop-first'))]))).toEqual({ kind: 'menu' });
    expect(readRateLimitScreen(shown(drawRateLimitMenu(rateLimitMenuRows('credits-first'))))).toEqual({ kind: 'menu' });
  });

  it('reads the menu by its rows when its title is off screen, never its pointer row as a prompt', () => {
    expect(readRateLimitScreen([`❯ 1. ${RATE_LIMIT_CREDITS_ROW}`, `  2. ${RATE_LIMIT_UPGRADE_ROW}`, `  3. ${RATE_LIMIT_STOP_ROW}`, 'Enter to confirm · Esc to cancel'])).toEqual({ kind: 'menu' });
    expect(readRateLimitScreen(['What do you want to do? Usage credit balance: $0', `❯ 1. ${RATE_LIMIT_CREDITS_ROW}`, `  2. ${RATE_LIMIT_UPGRADE_ROW}`])).toEqual({ kind: 'menu' });
  });

  it('reads a row of the menu with no number, or a list of numbered options it does not know, as the menu too', () => {
    expect(readRateLimitScreen([`❯ Add funds to continue with usage credits · $12.00`, '  Stop'])).toEqual({ kind: 'menu' });
    expect(readRateLimitScreen(['❯ 1. Something new', '  2. Something else'])).toEqual({ kind: 'menu' });
  });

  it('reads the prompt, holding the continue Claude put there, nothing, or other text', () => {
    expect(readRateLimitScreen(["You've hit your limit · resets 3pm", '> continue', '? for shortcuts'])).toEqual({ kind: 'prompt', holds: 'continue' });
    expect(readRateLimitScreen(['API Error: 429', '❯'])).toEqual({ kind: 'prompt', holds: '' });
    expect(readRateLimitScreen(['❯ and the tests'])).toEqual({ kind: 'prompt', holds: 'and the tests' });
  });

  it('takes a numbered list in a reply above the prompt for no menu', () => {
    expect(readRateLimitScreen(['1. Fixed the login test', '2. Ran the suite', '> continue'])).toEqual({ kind: 'prompt', holds: 'continue' });
  });

  it('reads from the bottom up: what is above the prompt, a reply quoting the menu or an old numbered message, is history', () => {
    expect(readRateLimitScreen(['Claude asks: What do you want to do? Pick one.', `It said ${RATE_LIMIT_STOP_ROW} earlier.`, '> continue'])).toEqual({ kind: 'prompt', holds: 'continue' });
    expect(readRateLimitScreen(['> 1. Fix the login test', 'Done: 1. Fix the login test.', "You've hit your limit · resets 3pm", '>'])).toEqual({ kind: 'prompt', holds: '' });
  });

  it('reads a menu below an old prompt as the menu', () => {
    expect(readRateLimitScreen(['> Fix the tests', 'API Error: 429', ...shown(drawRateLimitMenu(rateLimitMenuRows('credits-first')))])).toEqual({ kind: 'menu' });
  });

  it('calls a screen with neither menu nor prompt unknown, with its last line', () => {
    expect(readRateLimitScreen(['API Error: 429 Too Many Requests', ''])).toEqual({ kind: 'unknown', line: 'API Error: 429 Too Many Requests' });
  });
});
