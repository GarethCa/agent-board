import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW_SETTINGS, followViewSettings, restoreViewSettings, setCrewLook, setViewSetting, viewSettings } from './view-settings';

/** A window whose view state holds `saved` by key, and whose change listener the test can fire. */
function stubView(saved: Record<string, unknown> = {}) {
  let changed: (key: string, value: unknown) => void = () => {};
  const view = {
    get: vi.fn(async (key: string) => saved[key] ?? null),
    set: vi.fn(async () => {}),
    onChanged: vi.fn((listener: typeof changed) => {
      changed = listener;
      return () => {};
    }),
  };
  vi.stubGlobal('window', { agentBoard: { view } });
  vi.stubGlobal('document', { querySelectorAll: () => [] });
  return { view, change: (key: string, value: unknown) => changed(key, value) };
}

afterEach(() => {
  stubView();
  restoreViewSettings(DEFAULT_VIEW_SETTINGS);
  vi.unstubAllGlobals();
});

describe('the board view settings', () => {
  it('start as the board has always opened', () => {
    expect(DEFAULT_VIEW_SETTINGS).toEqual({ clickOpens: 'window', crewLook: 'frames', connections: 'all', agentNoteLook: 'document' });
  });

  it('change at once and are saved in the view state under their keys', () => {
    const { view } = stubView();
    setViewSetting('clickOpens', 'expand');
    setViewSetting('connections', 'handoffs');
    setCrewLook('chips');
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', connections: 'handoffs', crewLook: 'chips' });
    expect(view.set).toHaveBeenCalledWith('clickOpens', 'expand');
    expect(view.set).toHaveBeenCalledWith('connections', 'handoffs');
    expect(view.set).toHaveBeenCalledWith('crewLook', 'chips');
  });

  it('keep the same object while nothing changes, so a subscriber does not render again', () => {
    stubView();
    const before = viewSettings();
    setViewSetting('clickOpens', 'window');
    restoreViewSettings({ crewLook: 'nonsense' });
    expect(viewSettings()).toBe(before);
  });

  it('read back what was saved, a value it does not know as the default', () => {
    restoreViewSettings({ clickOpens: 'expand', agentNoteLook: 'nonsense' });
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', agentNoteLook: 'document' });
  });

  it('are read as a window follows them, and a change another window makes is heard', async () => {
    const { change } = stubView({ crewLook: 'off' });
    followViewSettings();
    await vi.waitFor(() => expect(viewSettings().crewLook).toBe('off'));
    change('clickOpens', 'expand');
    expect(viewSettings().clickOpens).toBe('expand');
    change('viewport', { x: 1 });
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', crewLook: 'off' });
  });
});
