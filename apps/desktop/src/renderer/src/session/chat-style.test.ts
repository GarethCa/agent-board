import { describe, expect, test } from 'vitest';
import { chatStyleOf, DEFAULT_CHAT_STYLE } from './chat-style';

describe('the chat style kept for every window', () => {
  test('is the one stored, or cards for none or one this version does not know', () => {
    expect(chatStyleOf('timeline')).toBe('timeline');
    expect(chatStyleOf('status-line')).toBe('status-line');
    expect(chatStyleOf(undefined)).toBe('cards');
    expect(chatStyleOf('bubbles')).toBe(DEFAULT_CHAT_STYLE);
  });
});
