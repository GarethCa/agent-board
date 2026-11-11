import { describe, expect, it } from 'vitest';
import { clampForYouHeight, clampPanelWidth, DEFAULT_PANEL_WIDTH, foldedSections, maxForYouHeight, maxPanelBottom, maxPanelWidth, MIN_FOR_YOU_HEIGHT, MIN_PANEL_HEIGHT, MIN_PANEL_WIDTH, panelBottom } from './panel-layout';

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

  it('keeps inside the room the Edge rules panel leaves, even when that is less than the least', () => {
    expect(maxPanelWidth(600, 426)).toBe(174);
    expect(clampPanelWidth(360, 600, 426)).toBe(174);
    expect(maxPanelWidth(400, 500)).toBe(0);
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

describe('the panel’s bottom edge', () => {
  it('is full height until one is chosen, and the snap position follows the measured lift', () => {
    expect(panelBottom(undefined, 90, 500)).toBe(0);
    expect(panelBottom('controls', 90, 500)).toBe(90);
    expect(panelBottom('200', 90, 500)).toBe(200);
  });
  it('is held between full height and the most the panel’s least height allows', () => {
    expect(panelBottom('900', 90, 500)).toBe(500);
    expect(panelBottom('controls', 90, 40)).toBe(40);
    expect(panelBottom('nonsense', 90, 500)).toBe(0);
  });
  it('leaves the panel its least height', () => {
    expect(maxPanelBottom(800, 60, 12)).toBe(800 - 60 - 12 - MIN_PANEL_HEIGHT);
    expect(maxPanelBottom(200, 60, 12)).toBe(0);
  });
});
