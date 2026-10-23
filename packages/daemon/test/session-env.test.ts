import { describe, expect, it } from 'vitest';
import { sessionEnv } from '../src/sessions.ts';

describe("a session's environment", () => {
  // Claude Code writes OSC 8 hyperlinks only where it thinks the terminal supports them; FORCE_HYPERLINK says so, but a
  // child inherits it (Claude's Bash tool, a shell), so the board sets none and leaves the user's own to pass through.
  it('sets no FORCE_HYPERLINK of its own, and keeps the one in the daemon env', () => {
    expect(sessionEnv('s1', { PATH: '/bin' }).FORCE_HYPERLINK).toBeUndefined();
    expect(sessionEnv('s1', { PATH: '/bin', FORCE_HYPERLINK: '1' }).FORCE_HYPERLINK).toBe('1');
  });
});
