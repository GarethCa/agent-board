// A ticket's tile in Simplified, Porthole and Shelf, drawn from the gallery's data: the ticket's own ask in Classic's
// word and button, in its own colour.
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalmTile } from './CalmTile';
import { PortholeTile } from './PortholeTile';
import { ShelfTile } from './ShelfTile';
import { TICKETS, WATCHED } from './TicketTileGallery';
import type { Agent } from '@agent-board/daemon/protocol';

type TileProps = { id: string; agent: Agent; helpers: Agent[] };
const DESIGNS: [string, FunctionComponent<TileProps>, string][] = [
  ['Simplified', CalmTile as FunctionComponent<TileProps>, 'status-mark'],
  ['Porthole', PortholeTile as FunctionComponent<TileProps>, 'porthole-word'],
  ['Shelf', ShelfTile as FunctionComponent<TileProps>, 'shelf-tile-word'],
];
const draw = (Tile: FunctionComponent<TileProps>, { chat, helpers }: { chat: Agent; helpers: Agent[] }) =>
  renderToStaticMarkup(createElement(Tile, { id: `agent:${chat.sessionId}`, agent: chat, helpers }));
const act = (html: string) => /data-testid="tile-act"[^>]*>(?:<[^>]+>)*([^<]+)/.exec(html)?.[1];

describe.each(DESIGNS)('a ticket’s tile in %s', (_, Tile, wordClass) => {
  it('says Ready to merge in green, with Merge, and never Needs you', () => {
    const html = draw(Tile, TICKETS['ready-to-merge']!);
    expect(html).toContain('Ready to merge');
    expect(html).toMatch(new RegExp(`class="${wordClass}[^"]*"[^>]*data-ask="merge"|data-ask="merge"[^>]*class="${wordClass}`));
    expect(act(html)).toBe('Merge');
    expect(html).not.toContain('Needs you');
  });

  it('says New review in blue, with Read', () => {
    const html = draw(Tile, WATCHED['new-review']!);
    expect(html).toContain('New review');
    expect(html).toContain('data-ask="new"');
    expect(act(html)).toBe('Read');
  });

  it('says Done once merged, with no button and no ask colour', () => {
    const html = draw(Tile, TICKETS['merged']!);
    expect(html).toContain('Done');
    expect(html).toContain('Merged as #645.');
    expect(html).not.toContain('data-testid="tile-act"');
    expect(html).not.toContain('data-ask=');
  });

  it('still speaks for a helper that asks', () => {
    expect(draw(Tile, TICKETS['needs-you']!)).toContain('Its builder asks: ');
  });
});
