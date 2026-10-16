/**
 * Runs an action for a key (an agent's session id) unless one is still going for it: a second press of Resume or
 * Restart, from its tile's corner or ⋯ menu, does nothing until the first has landed or failed.
 */
export function oneAtATime(): (key: string, action: () => Promise<unknown>) => Promise<void> {
  const going = new Set<string>();
  return async (key, action) => {
    if (going.has(key)) return;
    going.add(key);
    try {
      await action();
    } finally {
      going.delete(key);
    }
  };
}
