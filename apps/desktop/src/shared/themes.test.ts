import { describe, expect, it } from 'vitest';
import {
  appearanceFrom,
  appearanceFromQuery,
  appearanceQuery,
  DEFAULT_APPEARANCE,
  isAppearance,
  missingMode,
  MODES,
  themeFor,
  themeSourceFor,
  type Appearance,
  type Mode,
} from './appearance';
import { THEME_PACKS } from './theme-packs';
import { THEME_CHOICES, THEMES } from './themes';

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
      preview: { desk: '#181825', edge: '#313244', accent: '#89b4fa', running: '#a6e3a1', waiting: '#fab387', failed: '#f38ba8' },
      family: 'Catppuccin',
    });
  });

  it('credits every pack, and names no pack after another product', () => {
    for (const { family, credit } of THEME_PACKS) expect(credit, family).not.toBe('');
    const names = THEMES.map(({ name }) => name).join(' ');
    expect(names).not.toMatch(/Radix|Carbon|IBM|Atom|PRO|Blade|Buffy|Lincoln|Morbius|Van Helsing/);
  });
});

describe('the theme choices', () => {
  const choice = (id: string) => THEME_CHOICES.find((each) => each.id === id);

  it("starts with the app's own, then each family's, every theme in one of them", () => {
    expect(THEME_CHOICES[0]).toEqual({ id: 'agent-board', name: 'Agent Board', family: 'Agent Board', light: 'light', dark: 'dark' });
    const themes = THEME_CHOICES.flatMap(({ light, dark }) => [light, dark].filter((id) => id !== undefined));
    expect([...new Set(themes)].sort()).toEqual(THEMES.map(({ id }) => id).sort());
    expect(new Set(THEME_CHOICES.map(({ id }) => id)).size).toBe(THEME_CHOICES.length);
  });

  it("pairs a family's light and dark themes, so the mode picks between them", () => {
    expect(choice('catppuccin')).toEqual({
      id: 'catppuccin',
      name: 'Catppuccin',
      family: 'Catppuccin',
      credit: 'Catppuccin · MIT · github.com/catppuccin/catppuccin',
      light: 'catppuccin-latte',
      dark: 'catppuccin-mocha',
    });
    expect(choice('gruvbox')).toMatchObject({ light: 'gruvbox-light', dark: 'gruvbox-dark' });
  });

  it("makes a family's extra variants for one mode choices of their own, with the family's theme for the other mode", () => {
    expect(choice('catppuccin-frappe')).toEqual({
      id: 'catppuccin-frappe',
      name: 'Catppuccin Frappé',
      family: 'Catppuccin',
      credit: 'Catppuccin · MIT · github.com/catppuccin/catppuccin',
      light: 'catppuccin-latte',
      dark: 'catppuccin-frappe',
    });
    expect(choice('catppuccin-macchiato')).toMatchObject({ light: 'catppuccin-latte', dark: 'catppuccin-macchiato' });
  });

  it("gives every choice of a family the family's light theme in Light and its own dark one in Dark, the app's own only where the family has none", () => {
    for (const { family, themes } of THEME_PACKS) {
      const light = themes.find((theme) => theme.scheme === 'light')?.id ?? 'light';
      for (const each of THEME_CHOICES.filter((one) => one.family === family)) {
        const at = (mode: Mode) => themeFor({ mode, theme: each.id }, false).id;
        expect(at('light'), `${each.id} in light`).toBe(light);
        expect(at('dark'), `${each.id} in dark`).toBe(each.dark);
        expect(THEMES.find(({ id }) => id === each.dark)?.family, each.id).toBe(family);
      }
    }
  });

  it('leaves out the mode a dark-only family has no theme for', () => {
    expect(choice('nord')).toMatchObject({ dark: 'nord', light: undefined });
  });

  it('gives each family no more than one theme per mode, bar its own choices', () => {
    for (const { family, themes } of THEME_PACKS) {
      for (const scheme of ['light', 'dark'] as const) {
        const paired = themes.filter((theme) => theme.scheme === scheme && !('ownChoice' in theme && theme.ownChoice));
        expect(paired.length, `${family} ${scheme}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the Appearance setting', () => {
  const at = (mode: Mode, theme: string): Appearance => ({ mode, theme });

  it('is a mode and a theme choice, System and the app\'s own by default', () => {
    expect(DEFAULT_APPEARANCE).toEqual(at('system', 'agent-board'));
    expect(isAppearance(at('dark', 'nord'))).toBe(true);
    for (const value of [at('sepia' as Mode, 'nord'), at('dark', 'sepia'), at('dark', 'catppuccin-mocha'), 'dark', null, {}]) {
      expect(isAppearance(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('reads back a saved setting, and follows the system with the app\'s own when nothing it knows was saved', () => {
    for (const mode of MODES) for (const { id } of THEME_CHOICES) expect(appearanceFrom(at(mode, id))).toEqual(at(mode, id));
    for (const saved of [undefined, null, '', 'Dark', 'catppuccin', 1, {}, at('dark', 'sepia'), { mode: 'dusk', theme: 'nord' }]) {
      expect(appearanceFrom(saved), JSON.stringify(saved)).toEqual(DEFAULT_APPEARANCE);
    }
  });

  it("moves a theme saved before, or pinned by a test, to its choice, in that theme's own mode", () => {
    expect(appearanceFrom('system')).toEqual(at('system', 'agent-board'));
    expect(appearanceFrom('light')).toEqual(at('light', 'agent-board'));
    expect(appearanceFrom('dark')).toEqual(at('dark', 'agent-board'));
    expect(appearanceFrom('catppuccin-latte')).toEqual(at('light', 'catppuccin'));
    expect(appearanceFrom('catppuccin-mocha')).toEqual(at('dark', 'catppuccin'));
    expect(appearanceFrom('catppuccin-frappe')).toEqual(at('dark', 'catppuccin-frappe'));
    expect(appearanceFrom('rose-pine')).toEqual(at('dark', 'rose-pine'));
    expect(appearanceFrom('nord')).toEqual(at('dark', 'nord'));
    // Every theme, so moved, still shows itself.
    for (const theme of THEMES) expect(themeFor(appearanceFrom(theme.id), false).id, theme.id).toBe(theme.id);
  });

  it('reads a window\'s query, as written for it', () => {
    expect(appearanceFromQuery(appearanceQuery(at('light', 'gruvbox')))).toEqual(at('light', 'gruvbox'));
    for (const query of [null, '', '{', 'nord']) expect(appearanceFromQuery(query), String(query)).toEqual(query === 'nord' ? at('dark', 'nord') : DEFAULT_APPEARANCE);
  });

  it("shows the choice's theme for the mode, under System the window's, and the app's own where the choice has none", () => {
    expect(themeFor(at('system', 'agent-board'), false).id).toBe('light');
    expect(themeFor(at('system', 'agent-board'), true).id).toBe('dark');
    expect(themeFor(at('dark', 'agent-board'), false).id).toBe('dark');
    expect(themeFor(at('light', 'agent-board'), true).id).toBe('light');
    expect(themeFor(at('system', 'catppuccin'), false).id).toBe('catppuccin-latte');
    expect(themeFor(at('system', 'catppuccin'), true).id).toBe('catppuccin-mocha');
    expect(themeFor(at('light', 'catppuccin'), true).id).toBe('catppuccin-latte');
    expect(themeFor(at('dark', 'nord'), false).id).toBe('nord');
    expect(themeFor(at('light', 'nord'), true).id).toBe('light');
    expect(themeFor(at('system', 'nord'), false).id).toBe('light');
    expect(themeFor(at('system', 'catppuccin-frappe'), true).id).toBe('catppuccin-frappe');
    expect(themeFor(at('system', 'catppuccin-frappe'), false).id).toBe('catppuccin-latte');
    expect(themeFor(at('light', 'catppuccin-macchiato'), true).id).toBe('catppuccin-latte');
  });

  it('says which mode the choice has no theme for, while the setting can be in it', () => {
    expect(missingMode(at('system', 'nord'))).toBe('light');
    expect(missingMode(at('light', 'catppuccin-macchiato'))).toBeUndefined();
    expect(missingMode(at('dark', 'nord'))).toBeUndefined();
    expect(missingMode(at('system', 'catppuccin'))).toBeUndefined();
    expect(missingMode(at('light', 'agent-board'))).toBeUndefined();
  });

  it("puts the windows in the mode picked, or leaves it to the system", () => {
    expect(themeSourceFor(at('system', 'nord'))).toBe('system');
    expect(themeSourceFor(at('dark', 'agent-board'))).toBe('dark');
    expect(themeSourceFor(at('light', 'nord'))).toBe('light');
  });
});
