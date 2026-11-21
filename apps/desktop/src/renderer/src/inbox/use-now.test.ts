import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FixedNow, useNow, useNowForSince, useNowToward } from './use-now';

const AT = '2026-01-01T09:00:00.000Z';
const FIXED = Date.parse('2026-01-01T09:10:00.000Z');

function Times() {
  return createElement('span', null, [useNow(true), useNowForSince(AT), useNowToward(AT)].join(','));
}

describe('useNow', () => {
  it('gives a fixed time under FixedNow, from every hook, whatever the clock says', () => {
    expect(renderToStaticMarkup(createElement(FixedNow.Provider, { value: FIXED }, createElement(Times)))).toBe(`<span>${FIXED},${FIXED},${FIXED}</span>`);
  });

  it("gives the clock's time with none", () => {
    const before = Date.now();
    const shown = renderToStaticMarkup(createElement(Times)).replace(/<\/?span>/g, '').split(',').map(Number);
    for (const time of shown) expect(time).toBeGreaterThanOrEqual(before);
  });
});
