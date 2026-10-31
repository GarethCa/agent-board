import { describe, expect, test } from 'vitest';
import { hasAgentMessages, holdAgentMessages, setIncludeAgents } from './chat-filter';

describe("a session's chats and the choice of showing agents' messages", () => {
  test('two chats of one session hold messages: one closing leaves the choice to the other', () => {
    const panel = holdAgentMessages('captain');
    const window = holdAgentMessages('captain');
    expect(hasAgentMessages('captain')).toBe(true);
    panel();
    expect(hasAgentMessages('captain')).toBe(true);
    window();
    expect(hasAgentMessages('captain')).toBe(false);
  });

  test('a chat that lets go twice is counted once', () => {
    const first = holdAgentMessages('s');
    const second = holdAgentMessages('s');
    first();
    first();
    expect(hasAgentMessages('s')).toBe(true);
    second();
    expect(hasAgentMessages('s')).toBe(false);
  });

  test('a chat that shows only the user\'s own keeps the choice, so it can be undone, though no message is held', () => {
    setIncludeAgents('hidden', false);
    expect(hasAgentMessages('hidden')).toBe(true);
    setIncludeAgents('hidden', true);
    expect(hasAgentMessages('hidden')).toBe(false);
  });
});
