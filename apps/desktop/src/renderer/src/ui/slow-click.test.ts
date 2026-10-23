import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent, PointerEvent } from 'react';
import { createSlowClick, nameClicks, SLOW_CLICK_MS, SLOW_CLICK_SLOP_PX } from './slow-click';

const at = { x: 40, y: 20 };

describe('the slow click', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const start = vi.fn();
    return { start, rules: createSlowClick(start) };
  };

  it('starts the rename after a pause following a still click on an already-selected name', () => {
    const { start, rules } = setup();
    rules.down(at, true);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it("does nothing for the click that selects the tile", () => {
    const { start, rules } = setup();
    rules.down(at, false);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('never starts when a press after a wait on a selected tile drags it', () => {
    const { start, rules } = setup();
    rules.down(at, true);
    rules.click({ x: at.x + SLOW_CLICK_SLOP_PX + 1, y: at.y });
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('a press on an unselected tile ends what an earlier selected press began', () => {
    const { start, rules } = setup();
    rules.down(at, true);
    rules.down(at, false);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('lets a double-click open the tile: its second click waits again, until the double-click ends it', () => {
    const { start, rules } = setup();
    rules.down(at, true);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS / 2);
    rules.down(at, true);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS - 1);
    rules.cancel(); // the dblclick event
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('ends the wait when the tile is deselected', () => {
    const { start, rules } = setup();
    rules.down(at, true);
    rules.click(at);
    rules.cancel();
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts once per click, and again for the next one', () => {
    const { start, rules } = setup();
    for (let n = 1; n <= 2; n++) {
      rules.down(at, true);
      rules.click(at);
      vi.advanceTimersByTime(SLOW_CLICK_MS);
      expect(start).toHaveBeenCalledTimes(n);
    }
  });

  it('ends the wait on a press or key anywhere, not only on the name', () => {
    const start = vi.fn();
    let anywhere = () => {};
    const stopped = vi.fn();
    const rules = createSlowClick(start, SLOW_CLICK_MS, (cancel) => {
      anywhere = cancel;
      return stopped;
    });
    rules.down(at, true);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS / 2);
    anywhere(); // Enter, a button press, or a double-click's second click just off the title
    expect(stopped).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('stops listening once the wait has run out', () => {
    const stopped = vi.fn();
    const rules = createSlowClick(vi.fn(), SLOW_CLICK_MS, () => stopped);
    rules.down(at, true);
    rules.click(at);
    vi.advanceTimersByTime(SLOW_CLICK_MS);
    expect(stopped).toHaveBeenCalledOnce();
  });
});

describe("a name's handlers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const press = { clientX: 40, clientY: 20, button: 0, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
  const setup = (selectedAt: () => boolean) => {
    const start = vi.fn();
    return { start, clicks: nameClicks(createSlowClick(start), selectedAt) };
  };

  it("never renames on the click that selects the tile, even though it is selected by the time it is released", () => {
    let selected = false;
    const { start, clicks } = setup(() => selected);
    clicks.onPointerDownCapture(press as PointerEvent);
    selected = true; // the board selects it on this press
    clicks.onClick(press as MouseEvent);
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('renames on the next click of a tile that was selected before the press', () => {
    const { start, clicks } = setup(() => true);
    clicks.onPointerDownCapture(press as PointerEvent);
    clicks.onClick(press as MouseEvent);
    vi.advanceTimersByTime(SLOW_CLICK_MS);
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { button: 2 }])('ignores a press with %o', (extra) => {
    const { start, clicks } = setup(() => true);
    clicks.onPointerDownCapture({ ...press, ...extra } as PointerEvent);
    clicks.onClick(press as MouseEvent);
    vi.advanceTimersByTime(SLOW_CLICK_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });
});
