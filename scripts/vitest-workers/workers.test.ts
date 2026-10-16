import { describe, expect, it } from 'vitest';
import { chooseWorkers, type WorkerInputs } from './workers.ts';

const base: WorkerInputs = {
  cores: 10,
  load: 1,
  processCount: 300,
  processLimit: 2666,
  override: undefined,
};

describe('worker caps in the Vitest configs', () => {
  it('applies the chosen counts to both projects of the package config and the root config', async () => {
    const { packageConfig, workerCounts } = await import('../../vitest.shared.ts');
    const { default: root } = await import('../../vitest.config.ts');
    const counts = workerCounts();
    for (const config of [packageConfig(), root]) {
      const projects = (config.test?.projects ?? []) as { test: { name: string; maxWorkers: number } }[];
      expect(projects.map((p) => [p.test.name, p.test.maxWorkers])).toEqual([
        ['unit', counts.unit],
        ['processes', counts.processes],
      ]);
    }
  });
});

describe('chooseWorkers', () => {
  it('caps the processes project at 3 on an idle machine and leaves unit at cores - 1', () => {
    expect(chooseWorkers(base)).toMatchObject({ unit: 9, processes: 3 });
  });

  it('backs off both projects as the load rises', () => {
    expect(chooseWorkers({ ...base, load: 8 })).toMatchObject({
      unit: 2,
      processes: 1,
    });
  });

  it('never goes below one worker, even when the load exceeds the cores', () => {
    expect(chooseWorkers({ ...base, load: 40 })).toMatchObject({
      unit: 1,
      processes: 1,
    });
  });

  it('cuts the processes project when the user is near the process limit', () => {
    const out = chooseWorkers({ ...base, processCount: 2400 });
    expect(out.processes).toBe(1);
    expect(out.unit).toBeLessThan(9);
    expect(out.why).toContain('2400/2666');
  });

  it('treats a NaN load as idle rather than returning NaN workers', () => {
    expect(chooseWorkers({ ...base, load: Number.NaN })).toMatchObject({ unit: 9, processes: 3 });
  });

  it('says so when only the unit project is cut by the process limit', () => {
    const out = chooseWorkers({ ...base, processCount: 2000, processLimit: 2666 });
    expect(out.processes).toBe(3);
    expect(out.unit).toBeLessThan(9);
    expect(out.why).toContain('2000/2666');
  });

  it('ignores the process count when it is unknown', () => {
    expect(
      chooseWorkers({ ...base, processCount: null, processLimit: null }),
    ).toMatchObject({ unit: 9, processes: 3 });
  });

  it('lets AGENT_BOARD_VITEST_WORKERS override both projects', () => {
    expect(chooseWorkers({ ...base, override: '5' })).toMatchObject({
      unit: 5,
      processes: 5,
    });
  });

  it('ignores an invalid override', () => {
    expect(chooseWorkers({ ...base, override: 'lots' })).toMatchObject({
      unit: 9,
      processes: 3,
    });
    expect(chooseWorkers({ ...base, override: '0' })).toMatchObject({
      unit: 9,
      processes: 3,
    });
  });
});
