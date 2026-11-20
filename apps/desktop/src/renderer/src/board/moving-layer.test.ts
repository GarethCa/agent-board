import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOVING_LAYER_HOLD_MS, movingLayer } from './moving-layer';

/** A board root holding a moving layer, with just the style calls the module makes. */
function board() {
  const props = new Map<string, string>();
  const layer = {
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
  };
  const root = { querySelector: (selector: string) => (selector === '.react-flow__viewport' ? layer : null) } as unknown as HTMLElement;
  return { root, willChange: () => props.get('will-change') };
}

describe('movingLayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('promotes the layer while the camera moves, and drops it a while after it stops', () => {
    const { root, willChange } = board();
    const moving = movingLayer(() => root);
    expect(willChange()).toBeUndefined();
    moving.started();
    expect(willChange()).toBe('transform');
    moving.ended();
    vi.advanceTimersByTime(MOVING_LAYER_HOLD_MS - 1);
    expect(willChange(), 'held a moment after the camera stops').toBe('transform');
    vi.advanceTimersByTime(1);
    expect(willChange()).toBeUndefined();
  });

  it('keeps it promoted when the camera moves again within the hold', () => {
    const { root, willChange } = board();
    const moving = movingLayer(() => root);
    moving.started();
    moving.ended();
    vi.advanceTimersByTime(MOVING_LAYER_HOLD_MS / 2);
    moving.started();
    vi.advanceTimersByTime(MOVING_LAYER_HOLD_MS * 2);
    expect(willChange()).toBe('transform');
    moving.ended();
    vi.advanceTimersByTime(MOVING_LAYER_HOLD_MS);
    expect(willChange()).toBeUndefined();
  });

  it('drops it at once when disposed, and does nothing with no board', () => {
    const { root, willChange } = board();
    const moving = movingLayer(() => root);
    moving.started();
    moving.dispose();
    expect(willChange()).toBeUndefined();
    const none = movingLayer(() => null);
    expect(() => {
      none.started();
      none.ended();
      vi.runAllTimers();
    }).not.toThrow();
  });
});
