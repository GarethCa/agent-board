// A ticket's own board as the gallery draws it, from data alone: its breadcrumb, then its watches' news beside it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TicketBoardGallery } from './TicketTileGallery';

// The desk's dots are read from the theme's tokens, which have no page to be read from here.
vi.stubGlobal('document', { documentElement: {} });
vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '24' }));
afterAll(() => vi.unstubAllGlobals());
const html = renderToStaticMarkup(createElement(TicketBoardGallery));

describe("a ticket's own board, zoomed into", () => {
  it('has its breadcrumb back to the board, with its ticket, then an island of its watches with their icons and the eye', () => {
    const crumb = html.indexOf('data-testid="ticket-board-crumb"');
    const watches = html.indexOf('data-testid="ticket-board-watches"');
    expect(crumb).toBeGreaterThan(-1);
    expect(watches).toBeGreaterThan(crumb);
    expect(html.slice(crumb, watches)).toContain('ACME-726');
    const island = html.slice(watches);
    expect(island.match(/data-testid="ticket-watch-icon"/g)).toHaveLength(2);
    expect(island).toContain('aria-label="Watches"');
  });
});
