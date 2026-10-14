import { useEffect, useState } from 'react';

/** How long triggers must go quiet before the folder is looked up. */
const DEBOUNCE_MS = 250;
/** How often the open window asks again, to follow a `cd` it has no other sign of. */
const POLL_MS = 2_000;

export interface FolderRefresher {
  /** Asks for the folder once triggers settle: one lookup however many come. Nothing happens while hidden. */
  refresh(): void;
  /** Starts the light poll, and looks up now. */
  start(): void;
  /** Stops polling and drops any lookup waiting or in flight. */
  stop(): void;
}

/** When the details strip looks up a session's folder: on trigger, debounced, and polled while visible. */
export function createFolderRefresher(options: {
  fetch(): Promise<string>;
  onFolder(folder: string): void;
  visible(): boolean;
  debounceMs?: number;
  pollMs?: number;
}): FolderRefresher {
  const { fetch, onFolder, visible, debounceMs = DEBOUNCE_MS, pollMs = POLL_MS } = options;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  const refresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (!visible()) return;
      const mine = generation;
      fetch().then(
        (folder) => mine === generation && onFolder(folder),
        () => {},
      );
    }, debounceMs);
  };
  return {
    refresh,
    start() {
      poll ??= setInterval(refresh, pollMs);
      refresh();
    },
    stop() {
      generation += 1;
      clearTimeout(debounce);
      debounce = undefined;
      clearInterval(poll);
      poll = undefined;
    },
  };
}

/**
 * The folder `sessionId`'s process is in now, or undefined until the first answer (or without a session). It follows
 * focus: window focus and becoming visible look it up again, and a changed session starts afresh.
 */
export function useLiveFolder(sessionId: string | undefined): string | undefined {
  const [answer, setAnswer] = useState<{ sessionId: string; folder: string }>();
  useEffect(() => {
    if (sessionId === undefined) return;
    const refresher = createFolderRefresher({
      fetch: () => window.agentBoard.sessions.cwd(sessionId),
      onFolder: (folder) => setAnswer({ sessionId, folder }),
      visible: () => document.visibilityState === 'visible',
    });
    const onFocus = () => refresher.refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    refresher.start();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      refresher.stop();
    };
  }, [sessionId]);
  return answer?.sessionId === sessionId ? answer?.folder : undefined;
}

/** `path` with the home folder written as `~`. */
export function tildify(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Whether `folder` is the worktree or inside it. */
export function insideWorktree(folder: string, worktree: string): boolean {
  return folder === worktree || folder.startsWith(`${worktree.replace(/\/$/, '')}/`);
}
