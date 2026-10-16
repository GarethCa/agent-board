import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendedShortcuts, extendedShortcutsFrom, followExtendedShortcuts, setExtendedShortcuts } from './extended-shortcuts';

function stubView(saved: unknown) {
  const view = { get: vi.fn(async () => saved), set: vi.fn(async () => {}) };
  const events = new EventTarget();
  vi.stubGlobal('window', { agentBoard: { view }, addEventListener: events.addEventListener.bind(events) });
  return { view, focus: () => events.dispatchEvent(new Event('focus')) };
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
});
