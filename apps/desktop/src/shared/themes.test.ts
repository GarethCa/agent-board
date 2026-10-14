import { describe, expect, it } from 'vitest';
import { APPEARANCES, appearanceFrom, themeFor, themeSourceFor } from './appearance';
import { THEMES } from './themes';

describe('the theme registry', () => {
  it('has exactly one theme System picks for each of light and dark', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(THEMES.filter((theme) => theme.scheme === scheme && theme.system), scheme).toHaveLength(1);
    }
  });

  it('gives every theme a unique id', () => {
    expect(new Set(THEMES.map(({ id }) => id)).size).toBe(THEMES.length);
  });
});

describe('the Appearance setting', () => {
  it('is System or any theme in the registry, so a new theme is a new choice', () => {
    expect(APPEARANCES).toEqual(['system', ...THEMES.map(({ id }) => id)]);
  });

  it('reads back a saved choice, and follows the system when nothing it knows was saved', () => {
    for (const appearance of APPEARANCES) expect(appearanceFrom(appearance)).toBe(appearance);
    for (const saved of [undefined, null, '', 'Dark', 'catppuccin', 1, {}]) expect(appearanceFrom(saved)).toBe('system');
  });

  it('shows the theme picked, or under System the one for the window’s light or dark mode', () => {
    expect(themeFor('system', false).id).toBe('light');
    expect(themeFor('system', true).id).toBe('dark');
    expect(themeFor('dark', false).id).toBe('dark');
    expect(themeFor('light', true).id).toBe('light');
  });

  it('puts the windows in the picked theme’s light or dark mode, or leaves it to the system', () => {
    expect(themeSourceFor('system')).toBe('system');
    expect(themeSourceFor('dark')).toBe('dark');
    expect(themeSourceFor('light')).toBe('light');
  });
});
