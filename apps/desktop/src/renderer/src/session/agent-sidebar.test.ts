import { describe, expect, it } from 'vitest';
import { agentSidebarFrom, showsShelves, sidebarFor } from './agent-sidebar';

describe("an agent window's sidebar", () => {
  it('is the full details strip under Classic until Shelves is chosen', () => {
    expect(sidebarFor(false, agentSidebarFrom(undefined))).toBe('full');
    expect(sidebarFor(false, 'full')).toBe('full');
    expect(sidebarFor(false, 'shelves')).toBe('shelves');
  });

  it('is always the shelves under the Simplified design, whatever was chosen', () => {
    expect(sidebarFor(true, 'full')).toBe('shelves');
    expect(sidebarFor(true, 'shelves')).toBe('shelves');
  });

  it('reads back what was saved, Simple (which the shelves replace) as Shelves, and anything it does not know as Full', () => {
    expect(agentSidebarFrom('shelves')).toBe('shelves');
    expect(agentSidebarFrom('simple')).toBe('shelves');
    expect(agentSidebarFrom('full')).toBe('full');
    expect(agentSidebarFrom('compact')).toBe('full');
    expect(agentSidebarFrom(null)).toBe('full');
  });
});

describe('whether a session window shows the shelves', () => {
  const agent = { sessionId: 'a1' };
  it('does for an agent of its own while the sidebar is Shelves', () => {
    expect(showsShelves('shelves', { kind: 'session', agent })).toBe(true);
    expect(showsShelves('full', { kind: 'session', agent })).toBe(false);
  });

  it('does not for a session with no agent (one that is not an agent, one not yet listed, one deleted): it keeps the strip', () => {
    expect(showsShelves('shelves', { kind: 'session', agent: undefined })).toBe(false);
  });

  it('does not for a shell or a window of tabs', () => {
    expect(showsShelves('shelves', { kind: 'shell' })).toBe(false);
    expect(showsShelves('shelves', { kind: 'tabs' })).toBe(false);
  });
});
