import { describe, expect, it } from 'vitest';
import { commandLine, elapsedLabel } from './command-row';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('elapsedLabel', () => {
  it('says seconds, then minutes, then hours and minutes', () => {
    expect(elapsedLabel(40_000)).toBe('40 s');
    expect(elapsedLabel(22 * 60_000 + 59_000)).toBe('22 min');
    expect(elapsedLabel(65 * 60_000)).toBe('1 h 05');
    expect(elapsedLabel(-5_000)).toBe('0 s');
  });
});

describe('commandLine', () => {
  it('shows the longest-running command, its time, and how many more run', () => {
    const commands = [
      { command: 'pnpm check:pr', startedAt: ago(22 * 60_000) },
      { command: 'pnpm dev', startedAt: ago(60_000) },
    ];
    expect(commandLine({ state: 'on-command', commands }, NOW)).toEqual({ command: 'pnpm check:pr', more: 1, elapsed: '22 min' });
  });

  it('is nothing for an agent in any other state, or with no command', () => {
    expect(commandLine({ state: 'idle', commands: [{ command: 'sleep 9', startedAt: ago(0) }] }, NOW)).toBeUndefined();
    expect(commandLine({ state: 'on-command', commands: [] }, NOW)).toBeUndefined();
  });
});
