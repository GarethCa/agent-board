// A ticket's tile opened in place, in either view, drawn from data alone as the visual shots draw it: its header shows
// its watches as its card does.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TicketOpenGallery } from './TicketTileGallery';

const html = renderToStaticMarkup(createElement(TicketOpenGallery));
const head = (name: string) => {
  const cell = html.split(`data-testid="ticket-open-${name}"`)[1] ?? '';
  return cell.slice(cell.indexOf('<header'), cell.indexOf('</header>'));
};

describe("an opened ticket tile's header", () => {
  it.each(['terminal', 'card'])('in the %s view shows its pull request, its watch icons, then the eye, then the view switch, all past its fill', (name) => {
    const shown = head(name);
    expect(shown.match(/data-testid="ticket-watch-icon"/g)).toHaveLength(2);
    const fill = shown.indexOf('session-window-head-fill');
    const pr = shown.indexOf('data-testid="ticket-pr"');
    const icons = shown.indexOf('data-testid="ticket-watches"');
    const eye = shown.indexOf('aria-label="Watches"');
    const views = shown.indexOf('data-testid="ticket-view-switch"');
    expect(fill).toBeGreaterThan(-1);
    expect(fill).toBeLessThan(pr);
    expect(pr).toBeLessThan(icons);
    expect(icons).toBeLessThan(eye);
    expect(eye).toBeLessThan(views);
  });
});
