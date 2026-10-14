/**
 * Counts `key` up or down by one in `counts`, dropping it at zero, so `has` says whether any are left. A key already
 * dropped (its owner deleted meanwhile) counts down to nothing.
 */
export function recount<K>(counts: Map<K, number>, key: K, by: 1 | -1): void {
  const left = (counts.get(key) ?? (by < 0 ? 1 : 0)) + by;
  if (left <= 0) counts.delete(key);
  else counts.set(key, left);
}
