import { readFile } from 'node:fs/promises';
import type { FetchLike } from './link-metadata.ts';

/**
 * A `fetch` that serves the HTML file at `path` for every page and has nothing else, for the app's tests: the daemon
 * uses it when `$AGENT_BOARD_LINK_FETCH_HTML` is set, so they never reach the network.
 */
export function fixtureFetch(path: string): FetchLike {
  return async (url) => {
    if (/\.(ico|png|svg)$/.test(new URL(url).pathname)) return new Response('', { status: 404 });
    return new Response(await readFile(path), { headers: { 'content-type': 'text/html' } });
  };
}
