import { describe, expect, it } from 'vitest';
import type { Appearance, Mode } from '../../shared/appearance';
import type { Design } from '../../shared/design';
import { followDesign } from './design';
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

const at = (mode: Mode, theme = 'agent-board'): Appearance => ({ mode, theme });

/** A stand-in for a setting's preload API (Appearance, or the Simplified design), which main can change from any window. */
function setting<Value>(initial: Value) {
  const listeners = new Set<(value: Value) => void>();
  return {
    source: {
      initial,
      onChanged(listener: (value: Value) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    pick: (value: Value) => listeners.forEach((listener) => listener(value)),
    listening: () => listeners.size,
  };
}

/** The design today's tests open in. */
const classic = () => setting<Design>('classic').source;

describe('followTheme', () => {
  it('under System, shows the theme for the window’s light or dark mode, and again whenever it switches', () => {
    const os = scheme(false);
    const appearance = setting(at('system'));
    const root = { dataset: {} as DOMStringMap };
    const design = setting<Design>('classic');
    const stop = followTheme(root, os.query, appearance.source, design.source);
    expect(root.dataset.theme).toBe('light');
    os.flip(true);
    expect(root.dataset.theme).toBe('dark');
    os.flip(false);
    expect(root.dataset.theme).toBe('light');
    stop();
    expect(os.listening()).toBe(0);
    expect(appearance.listening()).toBe(0);
    expect(design.listening()).toBe(0);
  });

  it('shows a picked theme whatever the mode, and follows a pick made in any window', () => {
    const os = scheme(false);
    const appearance = setting(at('dark'));
    const root = { dataset: {} as DOMStringMap };
    followTheme(root, os.query, appearance.source, classic());
    expect(root.dataset.theme).toBe('dark');
    appearance.pick(at('light'));
    expect(root.dataset.theme).toBe('light');
    appearance.pick(at('system'));
    os.flip(true);
    expect(root.dataset.theme).toBe('dark');
  });

  it("shows a family's theme for the mode by its id, and its light or dark mode for what follows the mode rather than one theme", () => {
    const os = scheme(false);
    const appearance = setting(at('dark', 'catppuccin'));
    const root = { dataset: {} as DOMStringMap };
    followTheme(root, os.query, appearance.source, classic());
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-mocha', scheme: 'dark' });
    appearance.pick(at('system', 'catppuccin'));
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-latte', scheme: 'light' });
    os.flip(true);
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-mocha', scheme: 'dark' });
    appearance.pick(at('system'));
    expect(root.dataset).toMatchObject({ theme: 'dark', scheme: 'dark' });
  });

  it('shows a theme pack as the app’s own theme in its mode under the Simplified design, and the pack again under Classic', () => {
    const os = scheme(false);
    const appearance = setting(at('system', 'catppuccin'));
    const design = setting<Design>('simplified');
    const root = { dataset: {} as DOMStringMap };
    followTheme(root, os.query, appearance.source, design.source);
    expect(root.dataset).toMatchObject({ theme: 'light', scheme: 'light' });
    os.flip(true);
    expect(root.dataset).toMatchObject({ theme: 'dark', scheme: 'dark' });
    design.pick('classic');
    expect(root.dataset).toMatchObject({ theme: 'catppuccin-mocha', scheme: 'dark' });
    design.pick('simplified');
    expect(root.dataset).toMatchObject({ theme: 'dark', scheme: 'dark' });
  });
});

describe('followDesign', () => {
  it('marks the root under the Simplified design, and leaves no mark at all under Classic', () => {
    const design = setting<Design>('classic');
    const root = { dataset: {} as DOMStringMap };
    const stop = followDesign(root, design.source);
    expect(root.dataset).toEqual({});
    design.pick('simplified');
    expect(root.dataset).toEqual({ design: 'simplified' });
    design.pick('classic');
    expect(root.dataset).toEqual({});
    stop();
    expect(design.listening()).toBe(0);
  });

  it('opens in the design the window was opened in', () => {
    const root = { dataset: {} as DOMStringMap };
    followDesign(root, setting<Design>('simplified').source);
    expect(root.dataset.design).toBe('simplified');
  });
});
