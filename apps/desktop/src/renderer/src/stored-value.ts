// A string kept in localStorage that every window of the app hears change: the shape of the remembered sizes and
// folds (the details strip's width, the Captain's panel).

export interface StoredValue {
  /** The stored string, or undefined while none is. */
  get(): string | undefined;
  /** Stores the string (undefined forgets it) and tells every listener, here and in other windows. */
  set(value: string | undefined): void;
  /** Hears every change, here or in another window of the app; returns how to stop. */
  subscribe(listener: () => void): () => void;
}

export function storedValue(key: string): StoredValue {
  // Where storage is blocked the value lives for this run only.
  let memory: string | undefined;
  const load = (): string | undefined => {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return memory;
    }
  };
  const listeners = new Set<() => void>();
  return {
    get: load,
    set(value) {
      memory = value;
      try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // It just doesn't outlast this run.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      const fromOtherWindow = (event: StorageEvent) => {
        if (event.key === key) listener();
      };
      listeners.add(listener);
      window.addEventListener('storage', fromOtherWindow);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', fromOtherWindow);
      };
    },
  };
}
