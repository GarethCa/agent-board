import { describe, expect, it } from 'vitest';
import { oneAtATime } from './one-at-a-time';

/** A promise and the function that settles it. */
function deferred() {
  let settle!: (ok: boolean) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = (ok) => (ok ? resolve() : reject(new Error('no')));
  });
  return { promise, settle };
}

describe('an action run one at a time per agent', () => {
  it('ignores a second press while the first is still going, for that agent only', async () => {
    const run = oneAtATime();
    const first = deferred();
    const calls: string[] = [];
    const done = run('a', () => (calls.push('a1'), first.promise));
    void run('a', async () => void calls.push('a2'));
    await run('b', async () => void calls.push('b1'));
    expect(calls).toEqual(['a1', 'b1']);
    first.settle(true);
    await done;
    await run('a', async () => void calls.push('a3'));
    expect(calls).toEqual(['a1', 'b1', 'a3']);
  });

  it('lets the agent be pressed again once its action failed, passing the failure on', async () => {
    const run = oneAtATime();
    const failing = deferred();
    const done = run('a', () => failing.promise);
    failing.settle(false);
    await expect(done).rejects.toThrow('no');
    const calls: string[] = [];
    await run('a', async () => void calls.push('again'));
    expect(calls).toEqual(['again']);
  });
});
