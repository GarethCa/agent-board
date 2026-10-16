import { describe, expect, it } from 'vitest';
import { APPEARANCES, appearanceFrom, themeFor, themeSourceFor } from './appearance';
import { THEME_PACKS } from './theme-packs';
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

  it("lists every theme pack's themes after the app's own, each under its family, none of them System's pick", () => {
    const packs = THEMES.slice(2);
    expect(packs.map(({ id }) => id)).toEqual(THEME_PACKS.flatMap(({ themes }) => themes.map(({ id }) => id)));
    expect(THEME_PACKS).toHaveLength(13);
    expect(packs).toHaveLength(27);
    for (const theme of packs) expect(theme).toMatchObject({ system: false, family: expect.any(String) });
    expect(THEMES.find(({ id }) => id === 'catppuccin-mocha')).toEqual({
      id: 'catppuccin-mocha',
      name: 'Catppuccin Mocha',
      scheme: 'dark',
      system: false,
      desk: '#181825',
      family: 'Catppuccin',
    });
  });

  it('credits every pack, and names no pack after another product', () => {
    for (const { family, credit } of THEME_PACKS) expect(credit, family).not.toBe('');
    const names = THEMES.map(({ name }) => name).join(' ');
    expect(names).not.toMatch(/Radix|Carbon|IBM|Atom|PRO|Blade|Buffy|Lincoln|Morbius|Van Helsing/);
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
    expect(themeFor('nord', false).id).toBe('nord');
  });

  it('puts the windows in the picked theme’s light or dark mode, or leaves it to the system', () => {
    expect(themeSourceFor('system')).toBe('system');
    expect(themeSourceFor('dark')).toBe('dark');
    expect(themeSourceFor('light')).toBe('light');
    expect(themeSourceFor('catppuccin-mocha')).toBe('dark');
    expect(themeSourceFor('rose-pine-dawn')).toBe('light');
  });
});
