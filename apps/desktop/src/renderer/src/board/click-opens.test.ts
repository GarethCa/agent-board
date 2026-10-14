import { describe, expect, it } from 'vitest';
import { clickOpensFrom, tileOpenAction } from './click-opens';

describe('the click setting', () => {
  it('opens the session window unless Expand in place was saved', () => {
    expect(clickOpensFrom(null)).toBe('window');
    expect(clickOpensFrom('window')).toBe('window');
    expect(clickOpensFrom('expand')).toBe('expand');
    expect(clickOpensFrom('sideways')).toBe('window');
    expect(clickOpensFrom({ expand: true })).toBe('window');
  });
});

describe('what opening a tile does', () => {
  it('opens the session window by default', () => {
    expect(tileOpenAction('window', { hasWindow: true })).toBe('window');
  });

  it('expands in place with the setting changed', () => {
    expect(tileOpenAction('expand', { hasWindow: true })).toBe('expand');
  });

  it("expands an external session's tile, which has no session window", () => {
    expect(tileOpenAction('window', { hasWindow: false })).toBe('expand');
  });
});
