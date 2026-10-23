import { TrackerError } from './tracker.ts';

/** The error for an answer that isn't shaped the way agent-board reads it. */
function unexpected(what: string, source: string): TrackerError {
  return new TrackerError('unavailable', `${source} answered with something unexpected (${what} is missing or malformed): try again, or update agent-board`);
}

/** `value` as an object, or a friendly `TrackerError` naming `what`. */
export function objectOf(value: unknown, what: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unexpected(what, source);
  return value as Record<string, unknown>;
}

/** `value` as a list, or a friendly `TrackerError` naming `what`. */
export function listOf<T = unknown>(value: unknown, what: string, source: string): T[] {
  if (!Array.isArray(value)) throw unexpected(what, source);
  return value as T[];
}

/** The `nodes` of a GraphQL connection (`{ nodes: [...] }`) found at `key` of `data`. */
export function nodesOf<T = unknown>(data: unknown, key: string, source: string): T[] {
  return listOf<T>(objectOf(objectOf(data, key, source)[key], key, source).nodes, `${key}.nodes`, source);
}

/** `object[key]` as a string, or a friendly `TrackerError`. */
export function stringOf(object: Record<string, unknown>, key: string, what: string, source: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw unexpected(what, source);
  return value;
}

/** `JSON.parse`, with unparseable output as a friendly `TrackerError`. */
export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw unexpected('its JSON', source);
  }
}
