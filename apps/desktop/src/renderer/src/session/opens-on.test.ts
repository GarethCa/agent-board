import { describe, expect, test } from 'vitest';
import { opensOnOf } from './opens-on';

describe('the view agent windows open on', () => {
  test('is the one stored, or the chat for none or one this version does not know', () => {
    expect(opensOnOf('terminal')).toBe('terminal');
    expect(opensOnOf('chat')).toBe('chat');
    expect(opensOnOf(undefined)).toBe('chat');
    expect(opensOnOf('timeline')).toBe('chat');
    expect(opensOnOf('sideways')).toBe('chat');
  });
});
