import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHookRecorder, type HookRecorder } from '../src/index.ts';

describe('hook recorder', () => {
  let recorder: HookRecorder;

  beforeEach(async () => {
    recorder = await startHookRecorder();
  });

  afterEach(async () => {
    await recorder.close();
  });

  it('answers a non-JSON body with 400 and records nothing', async () => {
    const response = await fetch(recorder.url, { method: 'POST', body: 'not json' });

    expect(response.status).toBe(400);
    expect(recorder.events).toEqual([]);
  });
});
