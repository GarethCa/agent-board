import { describe, expect, it } from 'vitest';
import { trackerToSave } from './zone-tracker';

describe('trackerToSave', () => {
  const current = { provider: 'linear' as const, scope: 'ACME', project: 'p-1' };

  it('keeps the zone project while the scope is the same, however it is cased or padded', () => {
    expect(trackerToSave(current, 'linear', 'ACME')).toEqual(current);
    expect(trackerToSave(current, 'linear', ' acme ')).toEqual({ ...current, scope: 'acme' });
  });

  it('drops it for another scope or provider, and has none when the zone had none', () => {
    expect(trackerToSave(current, 'linear', 'OPS')).toEqual({ provider: 'linear', scope: 'OPS' });
    expect(trackerToSave(current, 'github', 'ACME')).toEqual({ provider: 'github', scope: 'ACME' });
    expect(trackerToSave({ provider: 'linear', scope: 'ACME' }, 'linear', 'ACME')).toEqual({ provider: 'linear', scope: 'ACME' });
    expect(trackerToSave(null, 'linear', 'ACME')).toEqual({ provider: 'linear', scope: 'ACME' });
  });
});
