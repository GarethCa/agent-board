import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchLike } from './link-metadata.ts';

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, and cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast, and the reserved range after it
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback, and the deprecated IPv4-compatible form (::127.0.0.1)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64: may embed a private IPv4 address
  ['100::', 64], // discard-only
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address` (an IPv4 or IPv6 literal) is somewhere the open internet doesn't reach: this machine, or a private network. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all: don't connect to it
  // An IPv4 address written in IPv6 (`::ffff:10.0.0.1`) is that IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return PRIVATE_RANGES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Host names that are local whatever they resolve to. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

export interface SafeFetchDeps {
  /** The addresses a host name has. */
  resolve(host: string): Promise<string[]>;
  /** Makes one request to `address`, the one already checked, with no redirects followed. */
  send(url: URL, address: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}

export interface SafeFetchOptions {
  /**
   * Lets a fetch reach this machine and private networks. Only for a test that serves a page from 127.0.0.1; the daemon
   * never sets it.
   */
  allowPrivate?: boolean;
}

/** `promise`, or a rejection as soon as `signal` aborts: a slow DNS answer is bound by the fetch's timeout too. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** How many redirects a fetch follows. */
const MAX_REDIRECTS = 5;

/**
 * A `fetch` for pages the user didn't choose to trust (a pasted link's page and its icon): https only, never to this
 * machine or a private network. The host is resolved and checked, the request goes to the address checked (so DNS can't
 * answer differently a moment later), and each redirect is followed by hand and checked the same way, up to
 * `MAX_REDIRECTS`. It rejects when a URL isn't allowed.
 */
export function createSafeFetch(deps: SafeFetchDeps = createNodeDeps(), options: SafeFetchOptions = {}): FetchLike {
  return async (start, init) => {
    let url = new URL(start);
    for (let hops = 0; ; hops++) {
      if (url.protocol !== 'https:') throw new Error(`not an https URL: ${url.href}`);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!options.allowPrivate && LOCAL_NAME.test(host)) throw new Error(`${host} is a local name`);
      const addresses = isIP(host) ? [host] : await abortable(deps.resolve(host), init.signal);
      if (addresses.length === 0) throw new Error(`${host} has no address`);
      if (!options.allowPrivate && addresses.some(isPrivateAddress)) {
        throw new Error(`${host} is on this machine or a private network`);
      }
      const response = await deps.send(url, addresses[0]!, init);
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null) return response;
      await response.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(location, url);
    }
  };
}

export interface NodeDepsOptions {
  /** Certificate authorities to trust instead of the system's, for a test server with its own certificate. */
  ca?: string | Buffer;
}

/** The real DNS and https: what the daemon's link cards fetch with. */
export function createNodeDeps(options: NodeDepsOptions = {}): SafeFetchDeps {
  return {
    resolve: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
    send: (url, address, init) =>
      new Promise((resolve, reject) => {
        const family = isIP(address);
        const req = request(
          url,
          {
            method: 'GET',
            headers: init.headers,
            signal: init.signal,
            ca: options.ca,
            // The connection goes to the address that was checked; the URL's host still names the TLS certificate.
            // Node asks for every address (`all`) when it may try several, and then wants a list.
            lookup: (_host, lookupOptions, callback) => {
              if (lookupOptions.all) {
                (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
              } else {
                (callback as (error: null, address: string, family: number) => void)(null, address, family);
              }
            },
          },
          (res) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            const status = res.statusCode ?? 502;
            const bodyless = status < 200 || status === 204 || status === 205 || status === 304;
            resolve(new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
          },
        );
        req.on('error', reject);
        req.end();
      }),
  };
}
