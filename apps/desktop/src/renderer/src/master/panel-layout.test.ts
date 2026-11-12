import { describe, expect, it } from 'vitest';
import { clampForYouHeight, clampPanelWidth, DEFAULT_PANEL_WIDTH, foldedSections, maxForYouHeight, maxPanelBottom, maxPanelWidth, MIN_FOR_YOU_HEIGHT, MIN_PANEL_HEIGHT, MIN_PANEL_WIDTH, paneLayout, paneMode, panelBottom, PUSH_KEEP_BOARD, PUSH_TOP_ROW } from './panel-layout';

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

describe('the pane beside the board, or over it', () => {
  const room = (board: number, extra: Partial<{ height: number; taken: number; lift: number }> = {}) => ({ board, height: 800, taken: 0, lift: 90, ...extra });

  it('pushes the board where its least leaves the top row its room, and covers it on a narrower one', () => {
    expect(paneMode(PUSH_TOP_ROW + MIN_PANEL_WIDTH)).toBe('push');
    expect(paneMode(1280)).toBe('push');
    expect(paneMode(PUSH_TOP_ROW + MIN_PANEL_WIDTH - 1)).toBe('cover');
    // With Edge rules open the board also keeps them their room, and the bottom row beside them.
    expect(paneMode(412 + PUSH_KEEP_BOARD + MIN_PANEL_WIDTH, 412)).toBe('push');
    expect(paneMode(412 + PUSH_KEEP_BOARD + MIN_PANEL_WIDTH - 1, 412)).toBe('cover');
    // Not yet measured, it is drawn as it will most likely be.
    expect(paneMode(0)).toBe('push');
  });

  it('takes its width from the board when it pushes, and nothing when it covers', () => {
    expect(paneLayout(room(1400), 400, undefined, 14)).toMatchObject({ mode: 'push', width: 400, room: 400 });
    expect(paneLayout(room(700), 400, undefined, 14)).toMatchObject({ mode: 'cover', width: 400, room: 0 });
  });

  it('pushing, runs full height whatever bottom was left, with nothing under it to end above', () => {
    expect(paneLayout(room(1400), 360, 'controls', 14)).toMatchObject({ bottom: 0, maxBottom: 0 });
    expect(paneLayout(room(1400), 360, '200', 14)).toMatchObject({ bottom: 0, maxBottom: 0 });
  });

  it('covering, keeps the bottom it was left at, from its flush top', () => {
    expect(paneLayout(room(700), 360, 'controls', 14)).toMatchObject({ bottom: 90, maxBottom: maxPanelBottom(800, 0, 14) });
    expect(paneLayout(room(700), 360, undefined, 14).bottom).toBe(0);
  });

  it('pushing, leaves the narrower board its top row, its bottom row and Edge rules', () => {
    expect(paneLayout(room(2400), 5000, undefined, 14).widest).toBe(maxPanelWidth(2400));
    expect(paneLayout(room(1280, { taken: 14 }), 5000, undefined, 14)).toMatchObject({ widest: 1280 - PUSH_TOP_ROW, width: 1280 - PUSH_TOP_ROW });
    expect(paneLayout(room(1400, { taken: 412 }), 5000, undefined, 14).widest).toBe(1400 - 412 - PUSH_KEEP_BOARD);
    expect(paneLayout(room(PUSH_TOP_ROW + MIN_PANEL_WIDTH), 5000, undefined, 14)).toMatchObject({ mode: 'push', widest: MIN_PANEL_WIDTH, width: MIN_PANEL_WIDTH });
  });

  it('covering, leaves Edge rules its room', () => {
    expect(paneLayout(room(800, { taken: 412 }), 5000, undefined, 14).widest).toBe(maxPanelWidth(800, 412));
  });

  it('keeps the chosen width until the board is measured', () => {
    expect(paneLayout(room(0, { height: 0 }), 512, undefined, 14)).toMatchObject({ width: 512, widest: DEFAULT_PANEL_WIDTH, bottom: 0 });
  });
});
