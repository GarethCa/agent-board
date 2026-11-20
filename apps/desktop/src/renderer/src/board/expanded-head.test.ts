import { describe, expect, it } from 'vitest';
import type { Shell } from '@agent-board/daemon/protocol';
import { expandTile, keptOnBoard } from './expanded';
import { headButtons, headDoubleClick } from './expanded-head';
import { galleryAgent } from './TileGallery';

describe("an expanded tile's header", () => {
  it('opens the window and pops out from a tile pinned expanded, as from any other', () => {
    const free = headButtons({ agent: { ...galleryAgent('waiting'), pinnedExpanded: false } });
    const pinned = headButtons({ agent: { ...galleryAgent('waiting'), pinnedExpanded: true } });
    expect(pinned.maximise).toEqual(free.maximise);
    expect(pinned.popOut).toEqual(free.popOut);
    expect(pinned.maximise).toMatchObject({ label: 'Maximise', tooltip: 'Maximise into its session window' });
    expect(pinned.popOut).toEqual({ label: 'Pop out', tooltip: 'Into its own window' });
    expect(JSON.stringify(pinned)).not.toMatch(/unpin it/i);
  });

  it("asks for a pinned tile's window by a path the pin lets through", () => {
    const { maximise } = headButtons({ agent: { ...galleryAgent('waiting'), pinnedExpanded: true } });
    expect(keptOnBoard('agent:1', new Set(['agent:1']), expandTile([], 'agent:1'), maximise!.path)).toBe(false);
  });

  it('ends in Unpin while pinned expanded, and Collapse otherwise', () => {
    expect(headButtons({ agent: { ...galleryAgent('waiting'), pinnedExpanded: true } }).closer).toBe('unpin');
    expect(headButtons({ agent: { ...galleryAgent('waiting'), pinnedExpanded: false } }).closer).toBe('collapse');
    expect(headButtons({ shell: { id: 's1' } as Shell }).closer).toBe('collapse');
  });

  it('has no window buttons for an external session', () => {
    const external = headButtons({});
    expect(external.maximise).toBeUndefined();
    expect(external.popOut).toBeUndefined();
  });
});

describe("a double-click on an expanded tile's header", () => {
  const pinned = { agent: { ...galleryAgent('waiting'), pinnedExpanded: true } };

  it('opens what a double-click on its tile opens, the pop-up by default, by a path the pin lets through', () => {
    expect(headDoubleClick('popup', pinned)).toEqual({ open: 'popUp', path: 'popUp' });
    expect(headDoubleClick('window', pinned)).toEqual({ open: 'maximise', path: 'maximise' });
    expect(headDoubleClick('maximised', pinned)).toEqual({ open: 'maximise', path: 'maximise' });
    const open = headDoubleClick('popup', pinned)!;
    expect(keptOnBoard('agent:1', new Set(['agent:1']), expandTile([], 'agent:1'), open.path)).toBe(false);
  });

  it('opens nothing under Expand in place, nor for an external session; a shell opens its window', () => {
    expect(headDoubleClick('expand', pinned)).toBeUndefined();
    expect(headDoubleClick('popup', {})).toBeUndefined();
    // A shell has no pop-up: its window.
    expect(headDoubleClick('popup', { shell: { id: 's1' } as Shell })).toEqual({ open: 'maximise', path: 'maximise' });
  });
});
