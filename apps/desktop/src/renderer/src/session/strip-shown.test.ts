import { describe, expect, it } from 'vitest';
import { OWN_SURFACE } from '@agent-board/daemon/window-layout';
import { ownPaneShown, stripShown } from './strip-shown';

describe('stripShown', () => {
  it('always draws the row of a single-pane window, with the pane state', () => {
    expect(stripShown(false, false, false, { state: 'attached' }, false)).toEqual({ row: true, paneStatus: true });
  });

  it.each(['attaching', 'attached'] as const)('draws no row for a healthy %s pane in a split', (state) => {
    expect(stripShown(true, false, false, { state }, false)).toEqual({ row: false, paneStatus: false });
  });

  it.each(['exited', 'detached', 'unavailable'] as const)('keeps the row, with the pane state, for a %s pane in a split', (state) => {
    expect(stripShown(true, false, false, { state }, false)).toEqual({ row: true, paneStatus: true });
  });

  it("draws no row for the window's own agent that exited, but keeps it if that agent's pane lost the daemon", () => {
    expect(stripShown(true, false, false, { state: 'exited' }, true)).toEqual({ row: false, paneStatus: false });
    expect(stripShown(true, false, false, { state: 'detached' }, true)).toEqual({ row: true, paneStatus: true });
  });

  it('keeps the row for an astray shell or a window problem, without the healthy pane state', () => {
    expect(stripShown(true, true, false, { state: 'attached' }, false)).toEqual({ row: true, paneStatus: false });
    expect(stripShown(true, false, true, { state: 'attached' }, false)).toEqual({ row: true, paneStatus: false });
  });

  it('draws no row under a row of tabs of its own, as in a split, but keeps it for what is amiss', () => {
    expect(stripShown(false, false, false, { state: 'attached' }, true, true)).toEqual({ row: false, paneStatus: false });
    expect(stripShown(false, false, false, { state: 'detached' }, true, true)).toEqual({ row: true, paneStatus: true });
    expect(stripShown(false, true, false, { state: 'attached' }, true, true)).toEqual({ row: true, paneStatus: false });
  });
});

describe('ownPaneShown', () => {
  const showing = (key: string) => ({ showing: (asked: string) => asked === key });

  it("is whether the agent's own pane shows: it does with no panes, or when it is the one on, under a pop-up's row of tabs too", () => {
    expect(ownPaneShown(undefined)).toBe(true);
    expect(ownPaneShown(showing(OWN_SURFACE))).toBe(true);
    expect(ownPaneShown(showing('shell-1'))).toBe(false);
  });
});
