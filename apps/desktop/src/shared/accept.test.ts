import { describe, expect, it } from 'vitest';
import { ACCEPT_AFTER_MS, acceptAfterArgs, acceptAfterFrom } from './accept';

describe('the Accept wait', () => {
  it('is the full wait when the window was given none', () => {
    expect(acceptAfterFrom(['/path/to/electron', '--type=renderer'])).toBe(ACCEPT_AFTER_MS);
  });

  it('is the one main hands the window', () => {
    expect(acceptAfterFrom(['--type=renderer', ...acceptAfterArgs('250')])).toBe(250);
  });

  it.each([undefined, '', '0', '-5', 'soon'])('gives the window no argument for %j', (ms) => {
    expect(acceptAfterArgs(ms)).toEqual([]);
  });
});
