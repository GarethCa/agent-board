// The watched ticket tiles at rest, drawn from data alone as the visual shots draw them: their middle row keeps every
// watch whole.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TicketWatchGallery } from './TicketTileGallery';

const html = renderToStaticMarkup(createElement(TicketWatchGallery));
const mid = (name: string) => {
  const cell = html.split(`data-testid="ticket-watch-${name}"`)[1] ?? '';
  const start = cell.indexOf('class="ticket-tile-mid"');
  return cell.slice(start, cell.indexOf('class="ticket-tile-foot', start));
};

describe('a watched ticket tile at rest', () => {
  it('beside the chat that builds, shows its hammer alone and its watches without words', () => {
    const row = mid('crowded');
    expect(row).toContain('data-testid="ticket-builds"');
    expect(row).not.toContain('>builds<');
    expect(row.match(/data-testid="ticket-watch-icon"/g)).toHaveLength(4);
    expect(row).not.toContain('ticket-tile-watch-label');
  });

  it.each(['new-review', 'told-chat'])('in %s, with three helpers, two watches and its pull request, drops the watches’ words and keeps every helper', (name) => {
    const row = mid(name);
    expect(row).not.toContain('data-testid="ticket-builds"');
    expect(row.match(/data-testid="ticket-watch-icon"/g)).toHaveLength(2);
    expect(row).not.toContain('ticket-tile-watch-label');
    expect(row.match(/class="ticket-tile-helper nodrag"/g)).toHaveLength(3);
  });
});
