import { describe, expect, test } from 'vitest';
import { chatThemeOf, DEFAULT_CHAT_THEME } from './chat-theme';

describe('the chat theme kept for every window', () => {
  test('is the one stored, or matching the app for none or one this version does not know', () => {
    expect(DEFAULT_CHAT_THEME).toBe('match');
    expect(chatThemeOf(undefined)).toBe('match');
    expect(chatThemeOf('sepia')).toBe('match');
    expect(chatThemeOf('match')).toBe('match');
    expect(chatThemeOf('light')).toBe('light');
    expect(chatThemeOf('dark')).toBe('dark');
  });
});
