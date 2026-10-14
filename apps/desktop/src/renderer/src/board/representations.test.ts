import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HybridTile } from './HybridTile';
import { REPRESENTATIONS, RepresentationProvider, tileComponentFor, type TileRegistry } from './representations';
import type { TileData, TileProps } from './tile';
import { TileNode } from './TileNode';

/** A second style, so choosing by style is observable: Hybrid alone is also the fallback. */
function StubTile({ tile }: TileProps) {
  return createElement('div', { 'data-representation': 'stub' }, tile.label);
}

const registry: TileRegistry = { ...REPRESENTATIONS, stub: StubTile };

const tile: TileData = { label: 'acme-6-board-zones', harness: 'claude' };

/** Renders a tile node the way the board does, under a board-wide style and the registry above. */
function renderTile(boardStyle: string, data: TileData): string {
  const node = createElement(TileNode, { id: 't1', data } as never);
  return renderToStaticMarkup(createElement(RepresentationProvider, { style: boardStyle, registry }, node));
}

describe('representation registry', () => {
  it('registers Hybrid as the only style in v1', () => {
    expect(Object.keys(REPRESENTATIONS)).toEqual(['hybrid']);
  });

  it('chooses the tile component by style', () => {
    expect(tileComponentFor('stub', registry)).toBe(StubTile);
    expect(tileComponentFor('hybrid', registry)).toBe(HybridTile);
  });

  it('falls back to Hybrid for a style the registry does not know', () => {
    expect(tileComponentFor('token', registry)).toBe(HybridTile);
    expect(tileComponentFor('token')).toBe(HybridTile);
  });

  it('draws a tile with the board-wide style', () => {
    const html = renderTile('stub', tile);
    expect(html).toContain('data-representation="stub"');
    expect(html).toContain('acme-6-board-zones');
    expect(renderTile('hybrid', tile)).toContain('data-representation="hybrid"');
  });

  it("lets a tile's own style override the board-wide one, either way round", () => {
    expect(renderTile('stub', { ...tile, style: 'hybrid' })).toContain('data-representation="hybrid"');
    expect(renderTile('hybrid', { ...tile, style: 'stub' })).toContain('data-representation="stub"');
  });
});
