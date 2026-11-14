/**
 * Runs `call` once the daemon has an item: at once when no create for it is `pending`, or when that create is done. As
 * the window goes (`leaving`) it runs at once, since the create's answer would never come back to it. The create still
 * lands first: the daemon takes a window's calls in the order they were sent, and it makes an item as it takes the call.
 */
export function runOnceCreated<T>(pending: Promise<unknown> | undefined, leaving: boolean, call: () => Promise<T>): Promise<T> {
  return pending === undefined || leaving ? call() : pending.then(call);
}
