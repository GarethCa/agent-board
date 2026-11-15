import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnknownItemCard } from './UnknownItemNode';

describe('the placeholder for an item of a kind this app does not know', () => {
  const html = renderToStaticMarkup(createElement(UnknownItemCard, { kind: 'mod', zoneId: 'z1' }));

  it('names the kind as its title, and says this version cannot show it', () => {
    expect(html).toContain('data-kind="mod"');
    expect(html).toContain('<div class="link-card-title">Mod item</div>');
    expect(html).toContain('This version of the app can&#x27;t show it');
  });

  it('is drawn in the plain card style, in its zone', () => {
    expect(html).toContain('class="link-card unknown-item"');
    expect(html).toContain('data-zone="z1"');
  });
});
