/**
 * Runs tasks given the same key one at a time, in the order given; tasks for different keys run concurrently. A
 * failing task fails only its own caller.
 */
export function keyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
