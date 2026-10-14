import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isObject } from './json.ts';
import { keyedQueue } from './keyed-queue.ts';
import type { ChatEntry, Harness, TranscriptChunk } from './protocol.ts';
import { createTranscriptParser, type TranscriptParser, type TranscriptParserOptions } from './transcript-adapters.ts';

/**
 * Reads agents' transcripts for the chat view as they grow. Each session's file is parsed once, from where the
 * last read stopped, and its latest entries kept, so a client polling it gets only what is new.
 *
 * Everything is bounded, since a long session's transcript runs to hundreds of megabytes: a file is read a megabyte at
 * a time, and one over `TAIL_START_BYTES` from that far before its end; a session keeps its last `MAX_KEPT_ENTRIES`
 * entries, the reader `MAX_CACHED` sessions, and a read returns at most `MAX_CHUNK_ENTRIES`, the latest. What is
 * left out is still in the terminal, and the chunk says so (`earlier`).
 */
export interface TranscriptReader {
  /**
   * The entries of the session's transcript at `path` from `since` on (at most the latest `MAX_CHUNK_ENTRIES`), reading
   * what was added since last time. A client passes back the `generation` it last got: from another one, it gets the
   * latest entries afresh.
   */
  read(key: string, harness: Harness, path: string | null, since: number, generation?: number): Promise<TranscriptChunk>;
  /**
   * A Claude subagent's own transcript, its latest entries: `<session>/subagents/agent-<id>.jsonl` beside the session's
   * transcript, found by its `agentId` or, failing that, by the call that started it (its `.meta.json` names it).
   * Codex's subagents talk in their parent's rollout, so there is none for Codex.
   */
  readSubagent(harness: Harness, path: string | null, toolUseId: string, agentId?: string): Promise<TranscriptChunk>;
  /** Drops what was read of the session's transcript. */
  forget(key: string): void;
}

/** How many sessions' transcripts are kept parsed; the least recently read goes first. */
const MAX_CACHED = 8;
/** How many of its latest entries a session keeps. */
export const MAX_KEPT_ENTRIES = 500;
/** The most entries one read returns: the latest. */
export const MAX_CHUNK_ENTRIES = 200;
/** A file bigger than this is read from this far before its end (and its first line, for Codex's session line). */
export const TAIL_START_BYTES = 8 * 1024 * 1024;
/** How much of the file one read of it takes at a time. */
const READ_CHUNK_BYTES = 1024 * 1024;
/** The longest line it waits for the end of; one longer makes the transcript unsupported. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

interface Tail {
  path: string;
  generation: number;
  /** The file it read, to notice one written over it. */
  ino: number;
  /** How far into the file it has read, in bytes. */
  offset: number;
  /** The bytes read of a line whose end hasn't been read yet. */
  partial: Buffer;
  /** Bytes still to drop up to the next line break: the rest of a line cut by starting near the end. */
  skipping: boolean;
  parser: TranscriptParser;
  /** Why it can't be read, beyond what the adapter says. */
  problem?: string;
  /** The latest entries; the first is entry number `first`. */
  entries: ChatEntry[];
  first: number;
  /** Whether it started near the end, so entries before the first it parsed aren't known. */
  skipped: boolean;
}

const none = (): TranscriptChunk => ({ status: 'none', generation: 0, from: 0, earlier: false, entries: [] });
const unsupported = (reason: string, generation: number): TranscriptChunk => ({ status: 'unsupported', reason, generation, from: 0, earlier: false, entries: [] });

export function createTranscriptReader(): TranscriptReader {
  const tails = new Map<string, Tail>();
  const queue = keyedQueue();
  // Seeded from the clock (with room for a thousand tails a millisecond), so a window still open across a daemon
  // restart never mistakes a new tail for one from before.
  let generations = Date.now() * 1000;

  const fresh = (harness: Harness, path: string, ino: number, options?: TranscriptParserOptions): Tail => ({
    path,
    generation: ++generations,
    ino,
    offset: 0,
    partial: Buffer.alloc(0),
    skipping: false,
    parser: createTranscriptParser(harness, options),
    entries: [],
    first: 0,
    skipped: false,
  });

  return {
    read(key, harness, path, since, generation) {
      return queue(key, async () => {
        const info = path === null ? undefined : await stat(path).catch(() => undefined);
        if (path === null || info === undefined) {
          tails.delete(key);
          return none();
        }
        let tail = tails.get(key);
        if (tail === undefined || tail.path !== path || tail.ino !== info.ino || info.size < tail.offset) tail = fresh(harness, path, info.ino);
        // Most recently read last, so the first is the one to drop.
        tails.delete(key);
        tails.set(key, tail);
        if (tails.size > MAX_CACHED) tails.delete(tails.keys().next().value!);

        await readNewLines(tail, info.size);
        return chunkOf(tail, generation === tail.generation ? since : 0);
      });
    },

    async readSubagent(harness, path, toolUseId, agentId) {
      if (harness !== 'claude' || path === null) return none();
      const folder = join(dirname(path), basename(path, '.jsonl'), 'subagents');
      const byAgent = agentId !== undefined && AGENT_ID.test(agentId) ? join(folder, `agent-${agentId}.jsonl`) : undefined;
      let file = byAgent;
      let info = file === undefined ? undefined : await stat(file).catch(() => undefined);
      if (info === undefined) {
        file = await subagentFileFor(folder, toolUseId);
        info = file === undefined ? undefined : await stat(file).catch(() => undefined);
      }
      if (file === undefined || info === undefined) return none();
      const tail = fresh('claude', file, info.ino, { subagent: true });
      await readNewLines(tail, info.size);
      return chunkOf(tail, 0);
    },

    forget(key) {
      tails.delete(key);
    },
  };
}

/** What a read returns from the tail: its entries from `since`, at most the latest `MAX_CHUNK_ENTRIES`. */
function chunkOf(tail: Tail, since: number): TranscriptChunk {
  const reason = tail.problem ?? tail.parser.unsupported;
  if (reason !== undefined) return unsupported(reason, tail.generation);
  const end = tail.first + tail.entries.length;
  const from = Math.min(end, Math.max(since, tail.first, end - MAX_CHUNK_ENTRIES));
  return {
    status: 'ok',
    generation: tail.generation,
    from,
    earlier: from > 0 || tail.skipped,
    entries: tail.entries.slice(from - tail.first),
  };
}

/** Reads the tail's file from where it stopped up to `size`, a chunk at a time, parsing each whole line. */
async function readNewLines(tail: Tail, size: number): Promise<void> {
  if (size <= tail.offset || tail.problem !== undefined || tail.parser.unsupported !== undefined) return;
  const handle = await open(tail.path, 'r');
  try {
    if (tail.offset === 0 && size > TAIL_START_BYTES) {
      // Far too much to read: its first line (Codex's session line, which says its version), then the end.
      await readLines(tail, handle, Math.min(size, MAX_LINE_BYTES), { firstLineOnly: true });
      tail.entries = [];
      tail.offset = Math.max(tail.offset, size - TAIL_START_BYTES);
      tail.partial = Buffer.alloc(0);
      tail.skipping = true;
      tail.skipped = true;
    }
    await readLines(tail, handle, size);
  } finally {
    await handle.close();
  }
}

async function readLines(tail: Tail, handle: Awaited<ReturnType<typeof open>>, size: number, { firstLineOnly = false } = {}): Promise<void> {
  const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - tail.offset));
  while (tail.offset < size && tail.problem === undefined && tail.parser.unsupported === undefined) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - tail.offset), tail.offset);
    if (bytesRead === 0) return;
    tail.offset += bytesRead;
    let data = Buffer.concat([tail.partial, buffer.subarray(0, bytesRead)]);
    if (tail.skipping) {
      const start = data.indexOf(NEWLINE);
      if (start < 0) {
        tail.partial = Buffer.alloc(0);
        continue;
      }
      data = data.subarray(start + 1);
      tail.skipping = false;
    }
    // Lines are split on the byte, so a character cut in two by a write still in progress waits for its other half.
    const end = firstLineOnly ? data.indexOf(NEWLINE) : data.lastIndexOf(NEWLINE);
    if (end < 0) {
      tail.partial = Buffer.from(data);
      if (tail.partial.length > MAX_LINE_BYTES) tail.problem = 'the transcript has a line over 16 MB';
      continue;
    }
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) keep(tail, tail.parser.push(line));
    tail.partial = Buffer.from(data.subarray(end + 1));
    if (firstLineOnly) return;
  }
}

/** Adds entries to the tail, dropping its oldest past `MAX_KEPT_ENTRIES`. */
function keep(tail: Tail, entries: ChatEntry[]): void {
  if (entries.length === 0) return;
  tail.entries.push(...entries);
  const over = tail.entries.length - MAX_KEPT_ENTRIES;
  if (over > 0) {
    tail.entries.splice(0, over);
    tail.first += over;
  }
}

/** The subagent transcript in `folder` whose `.meta.json` names the call that started it. */
async function subagentFileFor(folder: string, toolUseId: string): Promise<string | undefined> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith('.meta.json'))) {
    let meta: unknown;
    try {
      meta = JSON.parse(await readFile(join(folder, name), 'utf8'));
    } catch {
      continue;
    }
    if (isObject(meta) && meta.toolUseId === toolUseId) return join(folder, name.replace(/\.meta\.json$/, '.jsonl'));
  }
  return undefined;
}
