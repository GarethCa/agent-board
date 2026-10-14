import { describe, expect, it } from 'vitest';
import { handoffLine } from '../src/handoff-text.ts';

describe('handoffLine', () => {
  it("heads another agent's message with where it came from, so it never starts as a TUI command", () => {
    expect(handoffLine('Coder', 'final message', '!rm -rf ~')).toBe('Hand-off from Coder (its final message): !rm -rf ~');
    expect(handoffLine('Coder', 'final message', '/clear')).toBe('Hand-off from Coder (its final message): /clear');
  });

  it('names the file it carries', () => {
    expect(handoffLine('Planner', 'plan.md', '# Plan\n\n1. Add zoneId.')).toBe('Hand-off from Planner (its plan.md): # Plan 1. Add zoneId.');
  });

  it('drops control characters, so no escape sequence or ^C reaches the terminal, and joins its lines', () => {
    expect(handoffLine('Coder', 'final message', 'Done.\x1b[2J\x03 Next:\x15\tship\r\n\nit\x9b')).toBe(
      'Hand-off from Coder (its final message): Done.[2J Next: ship it',
    );
  });

  it('drops them from the names too', () => {
    expect(handoffLine('Co\x1bder', 'pl\x07an.md', 'Hi')).toBe('Hand-off from Coder (its plan.md): Hi');
  });
});
