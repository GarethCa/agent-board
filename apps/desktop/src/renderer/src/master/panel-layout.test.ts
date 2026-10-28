import { describe, expect, it } from 'vitest';
import { clampForYouHeight, clampPanelWidth, DEFAULT_PANEL_WIDTH, foldedSections, maxForYouHeight, maxPanelWidth, MIN_FOR_YOU_HEIGHT, MIN_PANEL_WIDTH } from './panel-layout';

describe('the Captain’s panel layout', () => {
  it('keeps the width between its least and most of the board', () => {
    expect(clampPanelWidth(10, 1400)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(5000, 1400)).toBe(maxPanelWidth(1400));
    expect(clampPanelWidth(412.4, 1400)).toBe(412);
    expect(clampPanelWidth(Number.NaN, 1400)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('leaves the bottom row its room, whichever is less', () => {
    expect(maxPanelWidth(1280, 700)).toBe(580);
    expect(maxPanelWidth(1280, 100)).toBe(768);
    expect(clampPanelWidth(900, 1280, 700)).toBe(580);
  });

  it('never lets a narrow board push the most below the least', () => {
    expect(maxPanelWidth(300)).toBe(MIN_PANEL_WIDTH);
  });

  it('leaves the chat room when the For you list grows', () => {
    const max = maxForYouHeight(700, 200);
    expect(max).toBe(340);
    expect(clampForYouHeight(900, max)).toBe(340);
    expect(clampForYouHeight(1, max)).toBe(MIN_FOR_YOU_HEIGHT);
  });

  it('reads the folded sections, ignoring anything else stored', () => {
    expect([...foldedSections('watching,digest,junk')]).toEqual(['watching', 'digest']);
    expect(foldedSections(undefined).size).toBe(0);
  });
});
