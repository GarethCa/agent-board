import { describe, expect, it } from 'vitest';
import { agentSidebarFrom, showsInspector, sidebarFor } from './agent-sidebar';

describe("an agent window's sidebar", () => {
  it('is the full details strip under Classic until Simple is chosen', () => {
    expect(sidebarFor(false, agentSidebarFrom(undefined))).toBe('full');
    expect(sidebarFor(false, 'full')).toBe('full');
    expect(sidebarFor(false, 'simple')).toBe('simple');
  });

  it('is always the simple inspector under the Simplified design, whatever was chosen', () => {
    expect(sidebarFor(true, 'full')).toBe('simple');
    expect(sidebarFor(true, 'simple')).toBe('simple');
  });

  it('reads back what was saved, anything it does not know as Full', () => {
    expect(agentSidebarFrom('simple')).toBe('simple');
    expect(agentSidebarFrom('full')).toBe('full');
    expect(agentSidebarFrom('compact')).toBe('full');
    expect(agentSidebarFrom(null)).toBe('full');
  });
});

describe('whether a session window shows the inspector', () => {
  const agent = { sessionId: 'a1' };
  it('does for an agent of its own while the sidebar is Simple', () => {
    expect(showsInspector('simple', { kind: 'session', agent })).toBe(true);
    expect(showsInspector('full', { kind: 'session', agent })).toBe(false);
  });

  it('does not for a session with no agent (one that is not an agent, one not yet listed, one deleted): it keeps the strip', () => {
    expect(showsInspector('simple', { kind: 'session', agent: undefined })).toBe(false);
  });

  it('does not for a shell or a window of tabs', () => {
    expect(showsInspector('simple', { kind: 'shell' })).toBe(false);
    expect(showsInspector('simple', { kind: 'tabs' })).toBe(false);
  });
});
