import { useEffect, useRef, useState } from 'react';
import type { TranscriptChunk } from '@agent-board/daemon/protocol';
import { mergeChunk, type Transcript } from './chat';

/** How often a subagent's conversation asks the daemon for what its transcript has gained. */
const POLL_MS = 750;
/**
 * How often the chat asks the daemon for what the agent's transcript has gained, should the daemon not say it changed:
 * it says so as the file is written, once the chat has read it, but can't for a file not written yet.
 */
const FALLBACK_POLL_MS = 3000;

/**
 * A transcript as the chat has it, read with `read` while `active`, merging in what it gained: again whenever `changes`
 * says it changed and `poke` changes, and while `follow`, every `POLL_MS` (`FALLBACK_POLL_MS` with `changes`). `read`
 * is called with where the last read stopped; a change heard during a read reads again once it is done.
 */
export function useTranscript(
  active: boolean,
  read: (since: number, generation?: number) => Promise<TranscriptChunk>,
  { follow = true, changes, poke }: { follow?: boolean; changes?: (read: () => void) => () => void; poke?: unknown } = {},
): Transcript | undefined {
  const [transcript, setTranscript] = useState<Transcript>();
  const latest = useRef<Transcript>(undefined);
  const reader = useRef(read);
  reader.current = read;
  const subscribe = useRef(changes);
  subscribe.current = changes;
  const readNow = useRef<() => void>(undefined);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      clearTimeout(timer);
      const current = latest.current;
      try {
        const chunk = await reader.current(current ? current.first + current.entries.length : 0, current?.generation);
        const next = mergeChunk(current, chunk);
        if (!stopped && next !== current) {
          latest.current = next;
          setTranscript(next);
        }
      } catch {
        // The daemon is away for a moment: the next poll tries again.
      }
      reading = false;
      if (stopped) return;
      if (again) {
        again = false;
        void poll();
      } else if (follow) {
        timer = setTimeout(() => void poll(), subscribe.current ? FALLBACK_POLL_MS : POLL_MS);
      }
    };
    readNow.current = () => void poll();
    const unsubscribe = subscribe.current?.(() => void poll());
    void poll();
    return () => {
      stopped = true;
      readNow.current = undefined;
      unsubscribe?.();
      clearTimeout(timer);
    };
  }, [active, follow]);
  // Read on every change of `poke`, but not as it mounts, when the read above has just started.
  const poked = useRef(poke);
  useEffect(() => {
    if (Object.is(poked.current, poke)) return;
    poked.current = poke;
    readNow.current?.();
  }, [poke]);
  return transcript;
}
