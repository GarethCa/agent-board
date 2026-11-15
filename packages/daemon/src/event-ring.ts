import { randomUUID } from 'node:crypto';
import { eventLine, type DaemonEvent } from './protocol.ts';

/** A broadcast event as the ring keeps it: its number, its type, and the line every client is sent, stamp and all. */
export interface RingEntry {
  seq: number;
  type: DaemonEvent['type'];
  line: string;
}

export interface EventRing {
  /** A random id made with the ring, once per daemon run. */
  readonly epoch: string;
  /** Numbers `event`, keeps it, and lets the oldest go past the ring's bounds. */
  append(event: DaemonEvent): RingEntry;
  /** The newest event's seq: 0 before the first. */
  last(): number;
  /**
   * The events after `seq`, oldest first: none if `seq` is the newest. Undefined if the ring can't give them all, as
   * it has let `seq + 1` go, or never reached `seq`: the client must start again from a snapshot.
   */
  after(seq: number): RingEntry[] | undefined;
}

/**
 * The ring's bounds: the last 10 000 events, or 16 Mi characters of their lines (about 16 MiB, as the lines are
 * mostly ASCII JSON), whichever is fewer.
 */
const MAX_EVENTS = 10_000;
const MAX_CHARS = 16 * 1024 * 1024;

/**
 * Every event the daemon broadcasts, numbered in order, with the most recent kept, so a client that drops can be
 * sent exactly the ones it missed.
 */
export function createEventRing(options: { epoch?: string; maxEvents?: number; maxChars?: number } = {}): EventRing {
  const epoch = options.epoch ?? randomUUID();
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const maxChars = options.maxChars ?? MAX_CHARS;
  // The entries held are kept[start..]; the ones before `start` are let go, and dropped from the array in batches.
  let kept: RingEntry[] = [];
  let start = 0;
  let chars = 0;
  let seq = 0;

  const dropOldest = () => {
    chars -= kept[start]!.line.length;
    start += 1;
    if (start > 1024 && start * 2 > kept.length) {
      kept = kept.slice(start);
      start = 0;
    }
  };

  return {
    epoch,
    append(event) {
      seq += 1;
      const entry: RingEntry = { seq, type: event.type, line: eventLine(event, { seq, epoch }) };
      kept.push(entry);
      chars += entry.line.length;
      while (start < kept.length && (kept.length - start > maxEvents || chars > maxChars)) dropOldest();
      return entry;
    },
    last: () => seq,
    after(from) {
      if (!Number.isInteger(from) || from < 0 || from > seq) return undefined;
      if (from === seq) return [];
      const oldest = start < kept.length ? kept[start]!.seq : seq + 1;
      if (from + 1 < oldest) return undefined;
      return kept.slice(start + (from + 1 - oldest));
    },
  };
}
