/**
 * Runs every guard's teardown, even after one throws, so one guard's failure never hides another's: throws the one
 * error there was, or all of them together.
 */
export function runEveryTeardown(teardowns: ReadonlyArray<() => void>): void {
  const errors: unknown[] = [];
  for (const teardown of teardowns) {
    try {
      teardown();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => (error instanceof Error ? error.message : String(error))).join('\n\n'));
}
