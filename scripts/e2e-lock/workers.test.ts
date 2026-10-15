import { expect, it } from 'vitest';
import { defaultWorkers } from './workers.ts';

it('runs 3 workers while the load is within one per core and 2 above it', () => {
  expect(defaultWorkers(0.5, 10)).toBe(3);
  expect(defaultWorkers(10, 10)).toBe(3);
  expect(defaultWorkers(10.1, 10)).toBe(2);
  expect(defaultWorkers(10.1, 16)).toBe(3);
});
