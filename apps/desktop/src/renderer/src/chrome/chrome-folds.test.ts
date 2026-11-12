import { describe, expect, it } from 'vitest';
import { chromeFolds, islandsWidth, toolbarShift } from './chrome-folds';

describe('the top row’s folds', () => {
  it('folds nothing in a wide window, then each step below its width', () => {
    expect(chromeFolds(1280)).toBe('');
    expect(chromeFolds(1240)).toBe('');
    expect(chromeFolds(1239)).toBe('1240');
    expect(chromeFolds(1099)).toBe('1240 1100');
    expect(chromeFolds(959)).toBe('1240 1100 960');
  });

  it('takes the islands’ width as the window’s, less the room the Captain’s pane takes beside the board', () => {
    expect(islandsWidth(1280, 1280, 1280)).toBe(1280);
    expect(islandsWidth(1280, 1280, 920)).toBe(920);
    expect(chromeFolds(islandsWidth(1280, 1280, 920))).toBe('1240 1100 960');
  });

  it('never counts a flow wider than the board as room', () => {
    expect(islandsWidth(1280, 1280, 1300)).toBe(1280);
  });

  it('keeps the toolbar in the board’s middle where it clears both islands', () => {
    expect(toolbarShift({ leftEnd: 300, rightStart: 1000, toolbar: 300, centre: 640 })).toBe(0);
  });

  it('moves the toolbar the least way that clears an island, keeping a gap either side', () => {
    // The board's middle puts the toolbar over the left island, so it moves right; over the right one, it moves left.
    expect(toolbarShift({ leftEnd: 300, rightStart: 720, toolbar: 390, centre: 460 })).toBe(300 + 8 - (460 - 195));
    expect(toolbarShift({ leftEnd: 100, rightStart: 600, toolbar: 300, centre: 500 })).toBe(600 - 8 - 300 - (500 - 150));
  });

  it('says the toolbar doesn’t fit where the islands leave it too little room, so the row folds further', () => {
    expect(toolbarShift({ leftEnd: 352, rightStart: 655, toolbar: 393, centre: 460 })).toBeUndefined();
    expect(toolbarShift({ leftEnd: 252, rightStart: 655, toolbar: 387, centre: 460 })).toBe(252 + 8 - (460 - 193.5));
  });
});
