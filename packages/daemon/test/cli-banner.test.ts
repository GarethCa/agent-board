import { describe, expect, it } from 'vitest';
import { cliBanner } from '../src/cli-banner.ts';

describe('cliBanner', () => {
  it("fills brand/cli-banner.txt with the build and the daemon's counts", () => {
    const banner = cliBanner({ version: 'abc1234 · 2026-10-12', sessions: 3, waiting: 2 });
    expect(banner).toContain('agent-board abc1234 · 2026-10-12');
    expect(banner).toContain('daemon up · 3 sessions reattached');
    expect(banner).toContain('2 agents need you');
    expect(banner).not.toMatch(/[{}]/);
  });

  it('says one session and one agent in the singular', () => {
    const banner = cliBanner({ version: 'v', sessions: 1, waiting: 1 });
    expect(banner).toContain('daemon up · 1 session reattached');
    expect(banner).toContain('1 agent needs you');
  });

  it('keeps the mark drawn above the words', () => {
    expect(cliBanner({ version: 'v', sessions: 0, waiting: 0 }).split('\n')[0]?.trim()).toBe('●');
  });
});
