import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PARTS_TO_TURN_ON, QUIET_TILE } from '../board/tile-shows';
import { restoreViewSettings } from '../board/view-settings';
import { TileShowsSetting } from './BoardViewSettings';

/** Each switch in the setting as drawn: its words, and whether it is on. */
function switches(): { label: string; on: boolean }[] {
  const html = renderToStaticMarkup(createElement(TileShowsSetting));
  return [...html.matchAll(/<label[^>]*>(.*?)<\/label>/g)].map(([, inner]) => ({ label: inner!.replace(/<[^>]*>/g, ''), on: /<input[^>]*checked=""/.test(inner!) }));
}

describe('the Tile shows setting', () => {
  afterEach(() => restoreViewSettings({ tileShows: QUIET_TILE }));

  it('draws a switch for each part, every one off on the quiet tile', () => {
    expect(switches()).toEqual(PARTS_TO_TURN_ON.map(({ label }) => ({ label, on: false })));
  });

  it('shows on just the parts the saved look turns on', () => {
    restoreViewSettings({ tileShows: { setBy: true, mutedInFooter: true } });
    const on = switches().filter((each) => each.on).map((each) => each.label);
    expect(on).toEqual(['Who set its status line', 'A muted bell in the footer, not by the name']);
  });
});
