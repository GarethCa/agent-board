import { describe, expect, it } from 'vitest';
import { paneOfSurface, singlePane, windowPanes, type Surface, type WindowLayout } from '@agent-board/daemon/window-layout';
import { placeBeside, placeBesideOf, sideOf, splitSurfaces } from './open-beside';

const own: Surface = { kind: 'own' };
const pr: Surface = { kind: 'pr', repo: 'acme/app', number: 7 };
const web: Surface = { kind: 'web', id: 'w', url: 'https://example.com' };
const review: Surface = { kind: 'review', sessionId: 'a' };

const ids = () => {
  let next = 0;
  return () => `id${++next}`;
};

describe('opening a tab beside the focused pane', () => {
  it('splits the pane, the tab in a new pane on its right, the divider where the sides want it', () => {
    const layout: WindowLayout = { ...singlePane([own]), id: 'p' };
    const sides: string[] = [];
    const next = placeBeside(layout, pr, 'p', ids(), (first, second) => {
      sides.push(`${sideOf(first)} ${sideOf(second)}`);
      return 0.37;
    });
    expect(next).toMatchObject({ type: 'split', direction: 'horizontal', ratio: 0.37, first: { id: 'p' }, second: { tabs: [pr], active: 'pr:acme/app#7' } });
    expect(sides).toEqual(['terminal page']);
  });

  it('moves a tab out of the focused pane into its own beside it', () => {
    const layout: WindowLayout = { ...singlePane([own, pr]), id: 'p' };
    const next = placeBeside(layout, pr, 'p', ids(), () => 0.5);
    expect(windowPanes(next).map((pane) => pane.tabs)).toEqual([[own], [pr]]);
  });

  it('only shows a tab already in another pane', () => {
    const layout: WindowLayout = { type: 'split', id: 's', direction: 'horizontal', ratio: 0.5, first: { type: 'pane', id: 'a', tabs: [own], active: 'own' }, second: { type: 'pane', id: 'b', tabs: [web, pr], active: 'web:w' } };
    const next = placeBeside(layout, pr, 'a', ids(), () => 0.2);
    expect(next).toMatchObject({ ratio: 0.5, second: { active: 'pr:acme/app#7' } });
  });

  it("leaves a pane's only tab in it, shown", () => {
    const layout: WindowLayout = { ...singlePane([pr]), id: 'p' };
    expect(placeBeside(layout, pr, 'p', ids(), () => 0.2)).toEqual(layout);
  });
});

describe('opening a tab beside another', () => {
  it('shows the other in the focused pane first, then the tab in a pane of its own right of it', () => {
    const layout: WindowLayout = { ...singlePane([own]), id: 'p' };
    const sides: string[] = [];
    const next = placeBesideOf(layout, review, pr, 'p', ids(), (first, second) => {
      sides.push(`${sideOf(first)} ${sideOf(second)}`);
      return 0.5;
    });
    expect(windowPanes(next).map((pane) => [pane.tabs, pane.active])).toEqual([
      [[own, review], 'review:a'],
      [[pr], 'pr:acme/app#7'],
    ]);
    expect(sides).toEqual(['page page']);
  });

  it('puts the tab beside the other where it already is', () => {
    const layout = placeBeside({ ...singlePane([own]), id: 'p' }, review, 'p', ids(), () => 0.5);
    const next = placeBesideOf(layout, review, pr, 'p', ids(), () => 0.5);
    expect(windowPanes(next).map((pane) => pane.tabs)).toEqual([[own], [review], [pr]]);
    expect(paneOfSurface(next, 'pr:acme/app#7')?.active).toBe('pr:acme/app#7');
  });
});

describe('what side a surface is', () => {
  it('counts sessions as terminals, and the rest as pages', () => {
    expect([own, { kind: 'shell', shellId: 's' }, { kind: 'session', target: { kind: 'agent', id: 'a' } }].map((each) => sideOf(each as Surface))).toEqual(['terminal', 'terminal', 'terminal']);
    expect([pr, web].map(sideOf)).toEqual(['page', 'page']);
  });
});

it('names the new pane with the first new id', () => {
  const layout: WindowLayout = { ...singlePane([own]), id: 'p' };
  expect(paneOfSurface(placeBeside(layout, web, 'p', ids(), () => 0.5), 'web:w')?.id).toBe('id1');
});

describe('what shows either side of a divider', () => {
  const layout: WindowLayout = {
    type: 'split',
    id: 'outer',
    direction: 'horizontal',
    ratio: 0.5,
    first: { type: 'split', id: 'inner', direction: 'vertical', ratio: 0.5, first: { type: 'pane', id: 'a', tabs: [own], active: 'own' }, second: { type: 'pane', id: 'b', tabs: [web, pr], active: 'pr:acme/app#7' } },
    second: { type: 'pane', id: 'c', tabs: [web], active: 'web:w' },
  };

  it('gives the surfaces the panes nearest the divider show', () => {
    expect(splitSurfaces(layout, 'outer')).toEqual({ first: pr, second: web });
    expect(splitSurfaces(layout, 'inner')).toEqual({ first: own, second: pr });
  });

  it('has none for a split gone', () => {
    expect(splitSurfaces(layout, 'gone')).toBeUndefined();
  });
});
