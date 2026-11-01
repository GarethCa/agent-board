import { describe, expect, test } from 'vitest';
import { conversationAsOf, openingView } from './conversation-as';

describe('how the conversation is shown', () => {
  test('is the one stored, or the chat for none or one this version does not know', () => {
    expect(conversationAsOf('timeline')).toBe('timeline');
    expect(conversationAsOf('chat')).toBe('chat');
    expect(conversationAsOf(undefined)).toBe('chat');
    expect(conversationAsOf('terminal')).toBe('chat');
    expect(conversationAsOf('sideways')).toBe('chat');
  });
});

describe('the view an agent window opens on', () => {
  test('is the terminal when windows open on it, whatever the conversation is shown as', () => {
    expect(openingView('terminal', 'chat')).toBe('terminal');
    expect(openingView('terminal', 'timeline')).toBe('terminal');
  });

  test('is the conversation, as it is shown, when windows open on the chat', () => {
    expect(openingView('chat', 'chat')).toBe('chat');
    expect(openingView('chat', 'timeline')).toBe('timeline');
  });
});
