import { describe, expect, it, vi } from 'vitest';
import { ESC_LADDER, escStep, type EscStep } from './esc-ladder';

const esc = (held: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'>> = {}) => ({
  key: 'Escape',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  target: null,
  ...held,
});

const step = (rung: EscStep['rung'], takes = true): EscStep => ({ rung, takes: () => takes, run: vi.fn() });

describe('the Esc ladder', () => {
  it('is written down once, innermost first: a gesture under way, the armed tool, the open shelves, the window or tile with the focus, then the tile in front', () => {
    expect(ESC_LADDER.map((rung) => rung.rung)).toEqual(['handOff', 'connect', 'tool', 'shelves', 'surface', 'frontTile']);
  });

  it('takes one step a press, the innermost that takes it, whatever order the steps came in', () => {
    const front = step('frontTile');
    const tool = step('tool');
    const surface = step('surface');
    expect(escStep([front, surface, tool], esc(), 'bubble')).toBe(tool);
    expect(escStep([front, surface], esc(), 'bubble')).toBe(surface);
    expect(escStep([front, step('surface', false)], esc(), 'bubble')).toBe(front);
  });

  it('folds open shelves before it leaves a window or collapses a tile, so one Esc never does both', () => {
    const shelves = step('shelves');
    const surface = step('surface');
    const front = step('frontTile');
    expect(escStep([front, surface, shelves], esc(), 'bubble')).toBe(shelves);
    expect(escStep([front, shelves], esc(), 'bubble')).toBe(shelves);
    expect(escStep([shelves], esc({ defaultPrevented: true }), 'bubble')).toBeUndefined();
  });

  it('calls off a hand-off or Connect to… first, in the capture phase, before anything inside has the press', () => {
    const handOff = step('handOff');
    const connect = step('connect');
    const tool = step('tool');
    expect(escStep([tool, connect, handOff], esc(), 'capture')).toBe(handOff);
    expect(escStep([tool, connect], esc(), 'capture')).toBe(connect);
    expect(escStep([tool], esc(), 'capture')).toBeUndefined();
    expect(escStep([handOff], esc(), 'bubble')).toBeUndefined();
  });

  it('leaves a press something inside took (a field, a menu, a dialog) to it: only the armed tool goes down as well, as it always has', () => {
    const tool = step('tool');
    const surface = step('surface');
    const front = step('frontTile');
    expect(escStep([surface, front], esc({ defaultPrevented: true }), 'bubble')).toBeUndefined();
    expect(escStep([tool, surface, front], esc({ defaultPrevented: true }), 'bubble')).toBe(tool);
  });

  it('calls off a gesture under way whatever is held, as ⌥ is held to draw a hand-off', () => {
    const handOff = step('handOff');
    expect(escStep([handOff], esc({ altKey: true }), 'capture')).toBe(handOff);
    expect(escStep([handOff], esc({ metaKey: true }), 'capture')).toBe(handOff);
    expect(escStep([handOff], esc({ altKey: true, isComposing: true }), 'capture')).toBeUndefined();
  });

  it('takes nothing while an input method is composing, nor Esc with a modifier but Shift once no gesture is under way', () => {
    const steps = [step('handOff'), step('tool'), step('frontTile')];
    expect(escStep(steps, esc({ isComposing: true }), 'capture')).toBeUndefined();
    expect(escStep(steps, esc({ isComposing: true }), 'bubble')).toBeUndefined();
    expect(escStep(steps, { ...esc(), key: 'Enter' }, 'bubble')).toBeUndefined();
    expect(escStep(steps.slice(1), esc({ metaKey: true }), 'bubble')).toBeUndefined();
    expect(escStep(steps.slice(1), esc({ ctrlKey: true }), 'bubble')).toBeUndefined();
    expect(escStep(steps.slice(1), esc({ shiftKey: true }), 'bubble')?.rung).toBe('tool');
  });
});
