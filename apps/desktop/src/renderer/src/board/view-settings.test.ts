import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUIET_TILE } from './tile-shows';
import { DEFAULT_VIEW_SETTINGS, followViewSettings, restoreViewSettings, setViewSetting, viewSettings, viewSettingsLoaded } from './view-settings';

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
    expect(DEFAULT_VIEW_SETTINGS).toEqual({ clickOpens: 'window', connections: 'all', tethers: false, agentNoteLook: 'document', agentSidebar: 'shelves', gpuTerminals: true, keepTerminals: false, tileShows: QUIET_TILE, chatRunsShow: 'always' });
  });

  it('change at once and are saved in the view state under their keys', () => {
    const { view } = stubView();
    setViewSetting('clickOpens', 'expand');
    setViewSetting('connections', 'handoffs');
    setViewSetting('tethers', true);
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', connections: 'handoffs', tethers: true });
    expect(view.set).toHaveBeenCalledWith('clickOpens', 'expand');
    expect(view.set).toHaveBeenCalledWith('connections', 'handoffs');
    expect(view.set).toHaveBeenCalledWith('tethers', true);
  });

  it('keep the same object while nothing changes, so a subscriber does not render again', () => {
    stubView();
    const before = viewSettings();
    setViewSetting('clickOpens', 'window');
    restoreViewSettings({ tethers: 'nonsense' });
    expect(viewSettings()).toBe(before);
  });

  it('save the tile look whole, and keep the same object when a window reads back an equal one', () => {
    const { view } = stubView();
    const look = { ...QUIET_TILE, branchAlways: true };
    setViewSetting('tileShows', look);
    expect(view.set).toHaveBeenCalledWith('tileShows', look);
    const after = viewSettings();
    restoreViewSettings({ tileShows: { ...look } });
    expect(viewSettings()).toBe(after);
    expect(viewSettings().tileShows.branchAlways).toBe(true);
  });

  it('read back what was saved, a value it does not know as the default', () => {
    restoreViewSettings({ clickOpens: 'expand', agentNoteLook: 'nonsense', agentSidebar: 'simple', tethers: 'yes' });
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', agentNoteLook: 'document', agentSidebar: 'shelves', tethers: false });
  });

  it('ignore a crew look saved before crews showed only on focus', () => {
    restoreViewSettings({ crewLook: 'chips' } as never);
    expect(viewSettings()).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it('are read as a window follows them, and a change another window makes is heard', async () => {
    const { change } = stubView({ tethers: true, gpuTerminals: false });
    followViewSettings();
    await vi.waitFor(() => expect(viewSettings().tethers).toBe(true));
    // Read, so what must not act on a default (a terminal taking the GPU) can go ahead.
    await vi.waitFor(() => expect(viewSettingsLoaded()).toBe(true));
    expect(viewSettings().gpuTerminals).toBe(false);
    change('clickOpens', 'expand');
    expect(viewSettings().clickOpens).toBe('expand');
    change('agentSidebar', 'shelves');
    expect(viewSettings().agentSidebar).toBe('shelves');
    change('viewport', { x: 1 });
    expect(viewSettings()).toMatchObject({ clickOpens: 'expand', tethers: true });
  });
});
