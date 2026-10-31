import { describe, expect, it } from 'vitest';
import type { Design } from '../../shared/design';
import { followTechnical, technicalShown } from './technical';

/** A stand-in for a setting's preload API, which main can change from any window or the View menu. */
function setting<Value>(initial: Value) {
  const listeners = new Set<(value: Value) => void>();
  return {
    source: {
      initial,
      onChanged(listener: (value: Value) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    pick: (value: Value) => listeners.forEach((listener) => listener(value)),
    listening: () => listeners.size,
  };
}

/** A root as `followDesign` leaves it: `data-design` under the Simplified design, nothing under Classic. */
const rootIn = (design: Design) => ({ dataset: (design === 'simplified' ? { design } : {}) as DOMStringMap });

describe('followTechnical', () => {
  it('marks the root while the switch is on under the Simplified design, and follows it both ways', () => {
    const technical = setting(false);
    const design = setting<Design>('simplified');
    const root = rootIn('simplified');
    const stop = followTechnical(root, technical.source, design.source);
    expect(root.dataset.technical).toBeUndefined();
    expect(technicalShown(root)).toBe(false);

    technical.pick(true);
    expect(root.dataset.technical).toBe('');
    expect(technicalShown(root)).toBe(true);

    technical.pick(false);
    expect(root.dataset.technical).toBeUndefined();
    expect(technicalShown(root)).toBe(false);

    stop();
    expect(technical.listening()).toBe(0);
    expect(design.listening()).toBe(0);
  });

  it('leaves no mark under Classic, which shows the technical layer whatever the switch says', () => {
    const technical = setting(true);
    const design = setting<Design>('classic');
    const root = rootIn('classic');
    followTechnical(root, technical.source, design.source);
    expect(root.dataset.technical).toBeUndefined();
    expect(technicalShown(root)).toBe(true);

    technical.pick(false);
    expect(technicalShown(root)).toBe(true);
  });

  it('marks the root when the Simplified design is picked with the switch already on, and clears it under Classic again', () => {
    const technical = setting(true);
    const design = setting<Design>('classic');
    const root = rootIn('classic');
    followTechnical(root, technical.source, design.source);

    root.dataset.design = 'simplified';
    design.pick('simplified');
    expect(root.dataset.technical).toBe('');
    expect(technicalShown(root)).toBe(true);

    delete root.dataset.design;
    design.pick('classic');
    expect(root.dataset.technical).toBeUndefined();
  });

  it('hides the layer under the Simplified design while the switch is off', () => {
    const root = rootIn('simplified');
    followTechnical(root, setting(false).source, setting<Design>('simplified').source);
    expect(technicalShown(root)).toBe(false);
  });
});
