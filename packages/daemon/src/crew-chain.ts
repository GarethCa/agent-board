// A crew's chain of leads: an agent, the orchestrator that started it, the one that started that, and so on. A crew
// goes any depth, so nothing that walks the chain may count on it ending: the walk stops at the top, or where
// the chain comes back on itself.

/**
 * `first` and the leads above it, nearest first: each id is the one `startedBy` gives for the id before it. Stops at
 * an agent no one started (`null`, or one no longer known: `undefined`), or at an id already in the chain.
 */
export function chainUp(first: string | null, startedBy: (sessionId: string) => string | null | undefined): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let at: string | null | undefined = first; at != null && !seen.has(at); at = startedBy(at)) {
    seen.add(at);
    chain.push(at);
  }
  return chain;
}
