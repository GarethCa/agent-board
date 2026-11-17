import { afterEach, describe, expect, it, vi } from 'vitest';
import { crewLit, crewsOf, focusedCrews, hoverCrew, leaveCrew, selectCrews, typeInTile } from './crew-view';

/** The board's root element, as `markCrewFocus` marks it. */
function fakeRoot() {
  const attributes = new Set<string>();
  return {
    attributes,
    toggleAttribute(name: string, on: boolean): boolean {
      if (on) attributes.add(name);
      else attributes.delete(name);
      return on;
    },
  };
}

afterEach(() => {
  typeInTile(undefined);
  selectCrews([]);
  leaveCrew('lead');
  leaveCrew('sub');
  vi.unstubAllGlobals();
});

describe('crewsOf', () => {
  it('puts an orchestrator in its own crew and in the crew of the one that started it', () => {
    expect(crewsOf('sub', true, 'lead')).toBe('sub lead');
    expect(crewsOf('lead', true, undefined)).toBe('lead');
    expect(crewsOf('worker', false, 'lead')).toBe('lead');
    expect(crewsOf('mine', false, undefined)).toBeUndefined();
  });
});

describe('the crew focus', () => {
  it('holds a hovered orchestrator until the pointer leaves it', () => {
    hoverCrew('lead');
    expect([...focusedCrews()]).toEqual(['lead']);
    leaveCrew('sub');
    expect([...focusedCrews()]).toEqual(['lead']);
    leaveCrew('lead');
    expect(focusedCrews().size).toBe(0);
  });

  it('keeps a selected orchestrator focused after the pointer leaves, and with another hovered', () => {
    selectCrews(['lead']);
    hoverCrew('sub');
    expect([...focusedCrews()].toSorted()).toEqual(['lead', 'sub']);
    leaveCrew('sub');
    expect([...focusedCrews()]).toEqual(['lead']);
    hoverCrew('lead');
    leaveCrew('lead');
    expect([...focusedCrews()]).toEqual(['lead']);
    selectCrews([]);
    expect(focusedCrews().size).toBe(0);
  });

  it('keeps the same set while nothing changes, so its subscribers redraw only on a change', () => {
    selectCrews(['lead']);
    const before = focusedCrews();
    selectCrews(['lead']);
    hoverCrew('lead');
    expect(focusedCrews()).toBe(before);
  });
});

describe('typing in an orchestrator\'s tile', () => {
  it('stops a selected orchestrator focusing its crew while the keyboard is in its tile, and gives it back after', () => {
    selectCrews(['lead']);
    typeInTile('lead');
    expect(focusedCrews().size).toBe(0);
    typeInTile(undefined);
    expect([...focusedCrews()]).toEqual(['lead']);
  });

  it('keeps the crew unfocused while the pointer rests on the tile being typed in', () => {
    selectCrews(['lead']);
    hoverCrew('lead');
    typeInTile('lead');
    expect(focusedCrews().size).toBe(0);
    leaveCrew('lead');
    hoverCrew('lead');
    expect(focusedCrews().size).toBe(0);
  });

  it("still focuses the crew from a chip naming it, and another orchestrator's crew on hover or selection", () => {
    selectCrews(['lead', 'sub']);
    typeInTile('lead');
    expect([...focusedCrews()]).toEqual(['sub']);
    hoverCrew('lead', 'chip');
    expect([...focusedCrews()].toSorted()).toEqual(['lead', 'sub']);
    leaveCrew('lead');
    expect([...focusedCrews()]).toEqual(['sub']);
  });

  it('leaves the focus alone while typing in a tile that leads no crew', () => {
    selectCrews(['lead']);
    typeInTile('worker');
    expect([...focusedCrews()]).toEqual(['lead']);
  });

  it("clears the board's dim mark while typing in the only focused orchestrator", () => {
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    selectCrews(['lead']);
    expect(root.attributes.has('data-crew-focus')).toBe(true);
    typeInTile('lead');
    expect(root.attributes.has('data-crew-focus')).toBe(false);
  });
});

describe('crewLit', () => {
  it("lights a focused crew's tiles, an orchestrator it started among them, and no other", () => {
    hoverCrew('lead');
    expect([crewLit('lead'), crewLit('sub lead'), crewLit('sub'), crewLit(undefined)]).toEqual([true, true, false, false]);
    selectCrews(['sub']);
    leaveCrew('lead');
    expect([crewLit('lead'), crewLit('sub lead'), crewLit('sub')]).toEqual([false, true, true]);
  });
});

describe('markCrewFocus', () => {
  it("marks the board's root while a crew is focused, so the other tiles dim, and clears it after", () => {
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    hoverCrew('lead');
    expect(root.attributes.has('data-crew-focus')).toBe(true);
    leaveCrew('lead');
    expect(root.attributes.has('data-crew-focus')).toBe(false);
  });
});
