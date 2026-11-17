import { describe, expect, it } from 'vitest';
import { keepPlanning, planChoices, planGlimpse, planTitle } from './claude-plan';

const PLAN = ['# Add Redis in front of getProduct()', '', '1. Add a `cache.ts` client', '2. Wrap `getProduct()`, 5 min TTL', '3. Bust on write', '4. Tests'].join('\n');

describe("Claude's plan approval", () => {
  it('is titled by its first heading, else its first line', () => {
    expect(planTitle(PLAN)).toBe('Add Redis in front of getProduct()');
    expect(planTitle('Do the thing\nthen another')).toBe('Do the thing');
    expect(planTitle('  \n')).toBe('');
  });

  it('shows its first lines after the title, and says where there is more', () => {
    expect(planGlimpse(PLAN)).toBe('1. Add a `cache.ts` client\n2. Wrap `getProduct()`, 5 min TTL\n3. Bust on write…');
    expect(planGlimpse('# Short\n\nOne step')).toBe('One step');
  });

  it("offers Claude's two yeses in its dialog's words and order, auto mode first", () => {
    expect(planChoices('auto mode')).toEqual([
      { label: 'Yes, and use auto mode', decision: { behavior: 'allow', scope: 'session' }, primary: true },
      { label: 'Yes, manually approve edits', decision: { behavior: 'allow' }, primary: false },
    ]);
  });

  it('offers auto-accept edits first where Claude suggested that for an account without auto mode', () => {
    expect(planChoices('all edits').map((choice) => choice.label)).toEqual(['Yes, auto-accept edits', 'Yes, manually approve edits']);
  });

  it('keeps planning with what to change, or with nothing said', () => {
    expect(keepPlanning('  Use the LRU first. ')).toEqual({ behavior: 'deny', message: 'Use the LRU first.' });
    expect(keepPlanning(' ')).toEqual({ behavior: 'deny' });
  });
});
