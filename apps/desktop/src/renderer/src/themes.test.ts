import { describe, expect, it } from 'vitest';
import type { Appearance } from '../../shared/appearance';
import { followTheme } from './themes';

/** A stand-in for `matchMedia('(prefers-color-scheme: dark)')` that the OS (or the Appearance setting) can flip. */
function scheme(dark: boolean) {
  const listeners = new Set<() => void>();
  return {
    query: {
      get matches() {
        return dark;
      },
      addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) => listeners.delete(listener),
    },
    flip(to: boolean) {
      dark = to;
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

/** A stand-in for the preload's Appearance API, which main can change from any window. */
function setting(initial: Appearance) {
  const listeners = new Set<(appearance: Appearance) => void>();
  return {
    source: {
      initial,
      onChanged(listener: (appearance: Appearance) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    pick: (appearance: Appearance) => listeners.forEach((listener) => listener(appearance)),
    listening: () => listeners.size,
  };
}

describe('followTheme', () => {
  it('under System, shows the theme for the window’s light or dark mode, and again whenever it switches', () => {
    const os = scheme(false);
    const appearance = setting('system');
    const root = { dataset: {} as DOMStringMap };
    const stop = followTheme(root, os.query, appearance.source);
    expect(root.dataset.theme).toBe('light');
    os.flip(true);
    expect(root.dataset.theme).toBe('dark');
    os.flip(false);
    expect(root.dataset.theme).toBe('light');
    stop();
    expect(os.listening()).toBe(0);
    expect(appearance.listening()).toBe(0);
  });

  it('shows a picked theme whatever the mode, and follows a pick made in any window', () => {
    const os = scheme(false);
    const appearance = setting('dark');
    const root = { dataset: {} as DOMStringMap };
    followTheme(root, os.query, appearance.source);
    expect(root.dataset.theme).toBe('dark');
    appearance.pick('light');
    expect(root.dataset.theme).toBe('light');
    appearance.pick('system');
    os.flip(true);
    expect(root.dataset.theme).toBe('dark');
  });

  it('shows a theme pack by its id, and its light or dark mode for what follows the mode rather than one theme', () => {
    const os = scheme(false);
    const appearance = setting('catppuccin-mocha');
    const root = { dataset: {} as DOMStringMap };
    followTheme(root, os.query, appearance.source);
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-mocha', scheme: 'dark' });
    appearance.pick('catppuccin-latte');
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-latte', scheme: 'light' });
    appearance.pick('system');
    expect(root.dataset).toMatchObject({ theme: 'light', scheme: 'light' });
  });
});
