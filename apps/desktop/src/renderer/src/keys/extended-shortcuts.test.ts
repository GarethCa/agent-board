import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendedShortcuts, extendedShortcutsFrom, followExtendedShortcuts, setExtendedShortcuts } from './extended-shortcuts';

function stubView(saved: unknown) {
  let changed: ((key: string, value: unknown) => void) | undefined;
  const view = {
    get: vi.fn(async () => saved),
    set: vi.fn(async () => {}),
    onChanged: vi.fn((listener: (key: string, value: unknown) => void) => {
      changed = listener;
      return () => {};
    }),
  };
  const events = new EventTarget();
  vi.stubGlobal('window', { agentBoard: { view }, addEventListener: events.addEventListener.bind(events) });
  return { view, focus: () => events.dispatchEvent(new Event('focus')), change: (key: string, value: unknown) => changed?.(key, value) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Extended keyboard shortcuts setting', () => {
  it('is on unless it was saved off', () => {
    expect(extendedShortcutsFrom(undefined)).toBe(true);
    expect(extendedShortcutsFrom(true)).toBe(true);
    expect(extendedShortcutsFrom('off')).toBe(true);
    expect(extendedShortcutsFrom(false)).toBe(false);
  });

  it('changes at once and is saved in the view state', () => {
    const { view } = stubView(undefined);
    setExtendedShortcuts(false);
    expect(extendedShortcuts()).toBe(false);
    expect(view.set).toHaveBeenCalledWith('keyboard.extendedShortcuts', false);
    setExtendedShortcuts(true);
    expect(extendedShortcuts()).toBe(true);
  });

  it('is read as the window opens, and again when it comes to the front', async () => {
    const { view, focus } = stubView(false);
    followExtendedShortcuts();
    await vi.waitFor(() => expect(extendedShortcuts()).toBe(false));
    view.get.mockResolvedValue(true);
    focus();
    await vi.waitFor(() => expect(extendedShortcuts()).toBe(true));
  });

  it('follows a change another window makes, such as the Settings window, without waiting to come to the front', async () => {
    const { change } = stubView(true);
    followExtendedShortcuts();
    await vi.waitFor(() => expect(extendedShortcuts()).toBe(true));
    change('keyboard.extendedShortcuts', false);
    expect(extendedShortcuts()).toBe(false);
    change('usageOnBoard', true);
    expect(extendedShortcuts()).toBe(false);
  });
});
