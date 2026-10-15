import { describe, expect, it } from 'vitest';
import { setSplitRatio } from '../src/pane-layout.ts';
import {
  paneSplitInto,
  parseWindowLayout,
  placeSurface,
  reconcileWindow,
  removeSurface,
  selectSurface,
  singlePane,
  surfaceKey,
  updateSurface,
  windowPanes,
  type Surface,
  type WindowLayout,
} from '../src/window-layout.ts';

const own: Surface = { kind: 'own' };
const shell = (shellId: string): Surface => ({ kind: 'shell', shellId });
const agentB: Surface = { kind: 'session', target: { kind: 'agent', id: 'b' } };
const pr41: Surface = { kind: 'pr', repo: 'acme/app', number: 41 };
const web: Surface = { kind: 'web', id: 'w1', url: 'http://localhost:5173/' };
const gate: Surface = { kind: 'gate', sessionId: 'a' };
const plan: Surface = { kind: 'plan', sessionId: 'a' };

/** Ids handed out in order: p1, p2… for panes and s1, s2… for splits alike, as a generator would. */
const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

/** Each pane's tab keys and active key, in layout order. */
const strips = (layout: WindowLayout) => windowPanes(layout).map((pane) => [pane.id, pane.tabs.map(surfaceKey), pane.active]);

describe('window layout', () => {
  it('names each kind of surface by a key of its own', () => {
    expect([own, shell('x'), agentB, { kind: 'session', target: { kind: 'shell', id: 't' } } as Surface, pr41, web, gate, plan].map(surfaceKey)).toEqual([
      'own',
      'shell:x',
      'session:agent:b',
      'session:shell:t',
      'pr:acme/app#41',
      'web:w1',
      'gate:a',
      'plan:a',
    ]);
    // A web tab is the same tab wherever its page goes.
    expect(surfaceKey({ kind: 'web', id: 'w1', url: 'https://example.com/' })).toBe(surfaceKey(web));
    // A repo's name in any case is the same pull request.
    expect(surfaceKey({ kind: 'pr', repo: 'Acme/App', number: 41 })).toBe(surfaceKey(pr41));
  });

  it("starts as one pane holding today's strip, its first tab showing", () => {
    expect(strips(singlePane([own, shell('x'), shell('y')]))).toEqual([['main', ['own', 'shell:x', 'shell:y'], 'own']]);
  });

  describe('reconcile', () => {
    it('lays out a window with no saved layout as one pane: the own surface, then its tabs in order', () => {
      expect(strips(reconcileWindow(null, [own, shell('x'), shell('y')], { newId: counter() }))).toEqual([['main', ['own', 'shell:x', 'shell:y'], 'own']]);
    });

    it('drops surfaces that are gone, and a pane left with none closes', () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, ids);
      const layout = reconcileWindow(two, [own], { newId: ids });
      expect(layout).toEqual(singlePane([own]));
    });

    it('appends a surface it has no place for to the pane it is told, else the last', () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, ids);
      expect(strips(reconcileWindow(two, [own, shell('x'), shell('y')], { newId: ids, into: 'main' }))).toEqual([
        ['main', ['own', 'shell:y'], 'own'],
        ['n1', ['shell:x'], 'shell:x'],
      ]);
      expect(strips(reconcileWindow(two, [own, shell('x'), shell('y')], { newId: ids, into: 'gone' }))).toEqual([
        ['main', ['own'], 'own'],
        ['n1', ['shell:x', 'shell:y'], 'shell:x'],
      ]);
    });

    it('puts a surface where a placement asks: a pane, or beside one at an edge', () => {
      const ids = counter();
      const placed = reconcileWindow(singlePane([own]), [own, shell('x'), shell('y')], {
        newId: ids,
        placement: (surface) => (surfaceKey(surface) === 'shell:y' ? { pane: 'main', edge: 'bottom' } : undefined),
      });
      expect(placed).toMatchObject({ type: 'split', direction: 'vertical', first: { id: 'main' }, second: { tabs: [shell('y')] } });
      expect(strips(placed)[0]).toEqual(['main', ['own', 'shell:x'], 'own']);
    });

    it('keeps a layout that needs nothing changed as it is', () => {
      const layout = singlePane([own, shell('x')]);
      expect(reconcileWindow(layout, [own, shell('x')], { newId: counter() })).toBe(layout);
    });

    it('keeps a session surface only while it is still available', () => {
      const layout = singlePane([own, agentB]);
      expect(reconcileWindow(layout, [own, agentB], { newId: counter() })).toBe(layout);
      expect(reconcileWindow(layout, [own], { newId: counter() })).toEqual(singlePane([own]));
    });
  });

  describe('placing a surface', () => {
    it('moves a tab to another strip at an index, leaving what each pane shows', () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x'), shell('y')]), shell('y'), { pane: 'main', edge: 'right' }, ids);
      const moved = placeSurface(two, shell('x'), { pane: 'n1', index: 0 }, ids);
      expect(strips(moved)).toEqual([
        ['main', ['own'], 'own'],
        ['n1', ['shell:x', 'shell:y'], 'shell:y'],
      ]);
    });

    it('rearranges a tab within its own strip, the index counted with it still there, as a drag along it sees the tabs', () => {
      const strip = singlePane([own, shell('x'), shell('y')]);
      expect(strips(placeSurface(strip, shell('y'), { pane: 'main', index: 1 }, counter()))).toEqual([['main', ['own', 'shell:y', 'shell:x'], 'own']]);
      expect(strips(placeSurface(strip, shell('x'), { pane: 'main', index: 3 }, counter()))).toEqual([['main', ['own', 'shell:y', 'shell:x'], 'own']]);
      expect(placeSurface(strip, shell('x'), { pane: 'main', index: 2 }, counter())).toEqual(strip);
    });

    it('splits a pane at each edge, the new pane on that side, holding and showing the tab', () => {
      const base = singlePane([own, shell('x')]);
      const at = (edge: 'left' | 'right' | 'top' | 'bottom') => placeSurface(base, shell('x'), { pane: 'main', edge }, counter());
      expect(at('right')).toMatchObject({ direction: 'horizontal', ratio: 0.5, first: { id: 'main' }, second: { id: 'n1', tabs: [shell('x')], active: 'shell:x' } });
      expect(at('left')).toMatchObject({ direction: 'horizontal', first: { id: 'n1' }, second: { id: 'main' } });
      expect(at('top')).toMatchObject({ direction: 'vertical', first: { id: 'n1' }, second: { id: 'main' } });
      expect(at('bottom')).toMatchObject({ direction: 'vertical', first: { id: 'main' }, second: { id: 'n1' } });
      expect(at('right')).toMatchObject({ id: 'n2' });
    });

    it("closes a pane whose last tab moves away, the rest taking its room", () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, ids);
      expect(placeSurface(two, shell('x'), { pane: 'main', index: 1 }, ids)).toEqual({ ...singlePane([own, shell('x')]) });
    });

    it("does nothing for a pane's only tab dropped back into its own strip or body, with one pane or several", () => {
      const ids = counter();
      const one = singlePane([own]);
      expect(placeSurface(one, own, { pane: 'main', index: 0 }, ids)).toBe(one);
      expect(placeSurface(one, own, { pane: 'main' }, ids)).toBe(one);
      const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, ids);
      expect(placeSurface(two, shell('x'), { pane: 'n1', index: 0 }, ids)).toBe(two);
      expect(placeSurface(two, shell('x'), { pane: 'n1', index: 1 }, ids)).toBe(two);
      expect(placeSurface(two, shell('x'), { pane: 'n1' }, ids)).toBe(two);
    });

    it("does nothing for a pane's only tab dropped on its own edge", () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, ids);
      expect(placeSurface(two, shell('x'), { pane: 'n1', edge: 'left' }, ids)).toBe(two);
    });

    it('adds a surface new to the window', () => {
      expect(strips(placeSurface(singlePane([own]), agentB, { pane: 'main' }, counter()))).toEqual([['main', ['own', 'session:agent:b'], 'own']]);
    });

    it('fails for a pane that is not there', () => {
      expect(() => placeSurface(singlePane([own]), shell('x'), { pane: 'nope' }, counter())).toThrow(/no pane nope/);
    });
  });

  describe('removing and selecting', () => {
    it('shows the tab before a closed one that was showing, as a browser does', () => {
      const layout = selectSurface(singlePane([own, shell('x'), shell('y')]), 'shell:y');
      expect(strips(removeSurface(layout, 'shell:y')!)).toEqual([['main', ['own', 'shell:x'], 'shell:x']]);
      expect(strips(removeSurface(layout, 'shell:x')!)).toEqual([['main', ['own', 'shell:y'], 'shell:y']]);
    });

    it('shows the next tab when the first one closes while showing', () => {
      expect(strips(removeSurface(singlePane([shell('x'), shell('y')]), 'shell:x')!)).toEqual([['main', ['shell:y'], 'shell:y']]);
    });

    it('is null once the last surface goes', () => {
      expect(removeSurface(singlePane([own]), 'own')).toBeNull();
    });

    it('selects a surface in whichever pane holds it, and leaves an unknown one be', () => {
      const ids = counter();
      const two = placeSurface(singlePane([own, shell('x'), shell('y')]), shell('y'), { pane: 'main', edge: 'right' }, ids);
      expect(strips(selectSurface(two, 'shell:x'))[0]).toEqual(['main', ['own', 'shell:x'], 'shell:x']);
      expect(selectSurface(two, 'shell:nope')).toBe(two);
    });
  });

  it("moves a divider between panes, within the limits, as a shell's panes do", () => {
    const two = placeSurface(singlePane([own, shell('x')]), shell('x'), { pane: 'main', edge: 'right' }, counter());
    expect(setSplitRatio(two, 'n2', 0.7)).toMatchObject({ ratio: 0.7 });
    expect(setSplitRatio(two, 'n2', 2)).toMatchObject({ ratio: 0.9 });
    expect(() => setSplitRatio(two, 'nope', 0.5)).toThrow(/no split nope/);
  });

  it("turns a tab's split into panes: its kept pane's strip where the tab was, each other pane a pane of its own as laid out", () => {
    const split = {
      type: 'split' as const,
      id: 'old',
      direction: 'horizontal' as const,
      ratio: 0.6,
      first: { type: 'pane' as const, sessionId: 'agent' },
      second: { type: 'split' as const, id: 'old2', direction: 'vertical' as const, ratio: 0.3, first: { type: 'pane' as const, sessionId: 'p1' }, second: { type: 'pane' as const, sessionId: 'p2' } },
    };
    const layout = paneSplitInto(singlePane([own, shell('x')]), 'main', split, 'agent', (sessionId) => shell(`row-${sessionId}`), counter());
    expect(layout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      first: { id: 'main', tabs: [own, shell('x')] },
      second: { type: 'split', direction: 'vertical', ratio: 0.3, first: { tabs: [shell('row-p1')], active: 'shell:row-p1' }, second: { tabs: [shell('row-p2')] } },
    });
    expect(() => parseWindowLayout(JSON.parse(JSON.stringify(layout)))).not.toThrow();
  });

  describe('update', () => {
    it("changes a surface in its place, its pane still showing it: a web tab's page as it goes elsewhere", () => {
      const two = placeSurface(singlePane([own, web]), shell('x'), { pane: 'main', edge: 'right' }, counter());
      const shown = selectSurface(two, 'web:w1');
      const moved = updateSurface(shown, { kind: 'web', id: 'w1', url: 'http://localhost:5173/about' });
      expect(strips(moved)).toEqual(strips(shown));
      expect(windowPanes(moved)[0]!.tabs[1]).toEqual({ kind: 'web', id: 'w1', url: 'http://localhost:5173/about' });
    });

    it('leaves the layout as it is when nothing changes, or the surface is not in it', () => {
      const one = singlePane([own, web]);
      expect(updateSurface(one, web)).toBe(one);
      expect(updateSurface(one, { kind: 'web', id: 'other', url: 'https://example.com/' })).toBe(one);
    });
  });

  describe('parse', () => {
    it('reads back what it wrote', () => {
      const two = placeSurface(singlePane([own, agentB, shell('x'), pr41, web, gate, plan]), shell('x'), { pane: 'main', edge: 'bottom' }, counter());
      expect(parseWindowLayout(JSON.parse(JSON.stringify(two)))).toEqual(two);
    });

    it.each([
      ['not an object', 3],
      ['an empty strip', { type: 'pane', id: 'p', tabs: [], active: 'own' }],
      ['an active tab not in its strip', { type: 'pane', id: 'p', tabs: [{ kind: 'own' }], active: 'shell:x' }],
      ['an unknown surface', { type: 'pane', id: 'p', tabs: [{ kind: 'iframe', url: 'https://x' }], active: 'own' }],
      ['a web surface with no id', { type: 'pane', id: 'p', tabs: [{ kind: 'web', url: 'https://example.com/' }], active: 'web:undefined' }],
      ['a web surface on a local file', { type: 'pane', id: 'p', tabs: [{ kind: 'web', id: 'w', url: 'file:///etc/passwd' }], active: 'web:w' }],
      ['a web surface on plain http elsewhere', { type: 'pane', id: 'p', tabs: [{ kind: 'web', id: 'w', url: 'http://example.com/' }], active: 'web:w' }],
      ['a PR surface with no repo', { type: 'pane', id: 'p', tabs: [{ kind: 'pr', number: 41 }], active: 'pr:undefined#41' }],
      ['a PR surface with no whole number', { type: 'pane', id: 'p', tabs: [{ kind: 'pr', repo: 'acme/app', number: '41' }], active: 'pr:acme/app#41' }],
      ['a PR surface numbered 0', { type: 'pane', id: 'p', tabs: [{ kind: 'pr', repo: 'acme/app', number: 0 }], active: 'pr:acme/app#0' }],
      ['a PR surface of no GitHub repo', { type: 'pane', id: 'p', tabs: [{ kind: 'pr', repo: '../..', number: 41 }], active: 'pr:../..#41' }],
      ['a gate surface of no agent', { type: 'pane', id: 'p', tabs: [{ kind: 'gate', sessionId: '' }], active: 'gate:' }],
      ['a plan surface of no agent', { type: 'pane', id: 'p', tabs: [{ kind: 'plan', sessionId: '' }], active: 'plan:' }],
      ['a session surface of no known kind', { type: 'pane', id: 'p', tabs: [{ kind: 'session', target: { kind: 'zone', id: 'z' } }], active: 'session:zone:z' }],
      [
        'a surface twice',
        {
          type: 'split',
          id: 's',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'pane', id: 'a', tabs: [{ kind: 'own' }], active: 'own' },
          second: { type: 'pane', id: 'b', tabs: [{ kind: 'own' }], active: 'own' },
        },
      ],
      [
        'a pane id twice',
        {
          type: 'split',
          id: 's',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'pane', id: 'a', tabs: [{ kind: 'own' }], active: 'own' },
          second: { type: 'pane', id: 'a', tabs: [{ kind: 'shell', shellId: 'x' }], active: 'shell:x' },
        },
      ],
      [
        'a ratio out of range',
        {
          type: 'split',
          id: 's',
          direction: 'horizontal',
          ratio: 1,
          first: { type: 'pane', id: 'a', tabs: [{ kind: 'own' }], active: 'own' },
          second: { type: 'pane', id: 'b', tabs: [{ kind: 'shell', shellId: 'x' }], active: 'shell:x' },
        },
      ],
    ])('refuses %s', (_, value) => {
      expect(() => parseWindowLayout(value)).toThrow(/not a window layout/);
    });
  });
});
