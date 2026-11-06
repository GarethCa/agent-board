import { describe, expect, it } from 'vitest';
import { railChoice, startsCollapsed } from './use-sidebar-collapsed';

describe('whether a sidebar opens collapsed', () => {
  it('is always so for the details strip, whatever the shelves were left as', () => {
    expect(startsCollapsed(false, undefined)).toBe(true);
    expect(startsCollapsed(false, 'rail')).toBe(true);
  });

  it('is as the shelves were last left: open until a rail was chosen', () => {
    expect(startsCollapsed(true, undefined)).toBe(false);
    expect(startsCollapsed(true, 'rail')).toBe(true);
    expect(startsCollapsed(true, 'anything else')).toBe(false);
  });

  it('is stored as the rail, or as nothing while the shelves are open, so every window and tile reads the same', () => {
    expect(railChoice(true)).toBe('rail');
    expect(railChoice(false)).toBeUndefined();
    expect(startsCollapsed(true, railChoice(true))).toBe(true);
    expect(startsCollapsed(true, railChoice(false))).toBe(false);
  });
});
