import { describe, expect, it } from 'vitest';
import { stripShown } from './strip-shown';

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
});
