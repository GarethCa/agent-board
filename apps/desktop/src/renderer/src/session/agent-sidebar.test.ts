import { describe, expect, it } from 'vitest';
import { showsShelves } from './agent-sidebar';

describe('whether a session window shows the shelves', () => {
  const agent = { sessionId: 'a1' };
  it('does for an agent of its own, under either design and whatever sidebar was once chosen', () => {
    expect(showsShelves({ kind: 'session', agent })).toBe(true);
  });

  it('does not for a session with no agent (one that is not an agent, one not yet listed, one deleted): it keeps the strip', () => {
    expect(showsShelves({ kind: 'session', agent: undefined })).toBe(false);
  });

  it('does not for a shell or a window of tabs', () => {
    expect(showsShelves({ kind: 'shell' })).toBe(false);
    expect(showsShelves({ kind: 'tabs' })).toBe(false);
  });
});
