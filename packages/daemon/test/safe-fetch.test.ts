import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDeps, createSafeFetch, isPrivateAddress, type SafeFetchDeps } from '../src/safe-fetch.ts';

const init = () => ({ signal: new AbortController().signal, redirect: 'follow' as const, headers: {} });

/** A safe fetch over fake DNS and a fake network, recording what it was asked to connect to. */
function fakeNetwork(
  dns: Record<string, string[]>,
  pages: Record<string, () => Response>,
): { fetch: ReturnType<typeof createSafeFetch>; connections: string[] } {
  const connections: string[] = [];
  const deps: SafeFetchDeps = {
    resolve: async (host) => dns[host] ?? [],
    send: async (url, address) => {
      connections.push(`${url.href} @ ${address}`);
      return pages[url.href]?.() ?? new Response('', { status: 404 });
    },
  };
  return { fetch: createSafeFetch(deps), connections };
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
const ok = (body = 'ok') => () => new Response(body, { status: 200 });

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    '::7f00:1',
    '::127.0.0.1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'not an address',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('createSafeFetch', () => {
  it('fetches a public https page at the address it resolved', async () => {
    const { fetch, connections } = fakeNetwork({ 'example.com': ['93.184.216.34'] }, { 'https://example.com/': ok('hi') });
    expect(await (await fetch('https://example.com/', init())).text()).toBe('hi');
    expect(connections).toEqual(['https://example.com/ @ 93.184.216.34']);
  });

  it('refuses local names, private addresses written out, and names that resolve to them', async () => {
    const { fetch, connections } = fakeNetwork({ 'sneaky.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }, {});
    for (const url of [
      'https://localhost/',
      'https://app.localhost/',
      'https://printer.local/',
      'https://db.internal/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data/',
      'https://192.168.1.10/admin',
      'https://sneaky.example.com/',
      'https://mixed.example.com/',
      'https://unresolvable.example.com/',
    ]) {
      await expect(fetch(url, init()), url).rejects.toThrow();
    }
    expect(connections).toEqual([]);
  });

  it('refuses http, whatever it is', async () => {
    const { fetch } = fakeNetwork({ 'example.com': ['93.184.216.34'] }, {});
    await expect(fetch('http://example.com/', init())).rejects.toThrow('not an https URL');
  });

  it('follows a redirect between public pages, and checks the host of each hop', async () => {
    const { fetch, connections } = fakeNetwork(
      { 'a.example.com': ['93.184.216.34'], 'b.example.com': ['93.184.216.35'], 'evil.example.com': ['93.184.216.36'] },
      {
        'https://a.example.com/': redirect('https://b.example.com/page'),
        'https://b.example.com/page': ok('arrived'),
        'https://evil.example.com/': redirect('https://127.0.0.1:8080/admin'),
      },
    );

    expect(await (await fetch('https://a.example.com/', init())).text()).toBe('arrived');
    await expect(fetch('https://evil.example.com/', init())).rejects.toThrow('private network');
    expect(connections).not.toContainEqual(expect.stringContaining('127.0.0.1'));
  });

  it('refuses a redirect to http or to a private name, and stops a redirect loop', async () => {
    const { fetch } = fakeNetwork(
      { 'a.example.com': ['93.184.216.34'] },
      {
        'https://a.example.com/down': redirect('http://a.example.com/'),
        'https://a.example.com/local': redirect('https://localhost/'),
        'https://a.example.com/loop': redirect('https://a.example.com/loop'),
      },
    );
    await expect(fetch('https://a.example.com/down', init())).rejects.toThrow('not an https URL');
    await expect(fetch('https://a.example.com/local', init())).rejects.toThrow('local name');
    await expect(fetch('https://a.example.com/loop', init())).rejects.toThrow('too many redirects');
  });
});

describe('createSafeFetch over the real transport', () => {
  // A real https server on 127.0.0.1 with its own certificate for `pinned.example.com`, a name nothing resolves: the
  // fake resolver sends it to the server, so the request only arrives if the connection goes to the address checked.
  const NAME = 'pinned.example.com';
  let dir: string;
  let server: Server;
  let cert: string;
  let port: number;
  const connectedTo: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-safe-fetch-'));
    execFileSync('openssl', [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${NAME}`],
      ...['-addext', `subjectAltName=DNS:${NAME}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
    ], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      connectedTo.push(`${req.headers.host} ${req.url}`);
      if (req.url === '/hop') res.writeHead(302, { location: `https://${NAME}:${port}/page` }).end();
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Served for real</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const nodeDeps = () => ({ ...createNodeDeps({ ca: cert }), resolve: async () => ['127.0.0.1'] });

  it('connects to the checked address, with the name in the certificate and a redirect followed', async () => {
    const fetch = createSafeFetch(nodeDeps(), { allowPrivate: true });

    const response = await fetch(`https://${NAME}:${port}/hop`, init());

    expect(await response.text()).toBe('<title>Served for real</title>');
    expect(connectedTo.slice(-2)).toEqual([`${NAME}:${port} /hop`, `${NAME}:${port} /page`]);
  });

  it('is refused by the guard unless the test allows this machine', async () => {
    const before = connectedTo.length;
    await expect(createSafeFetch(nodeDeps())(`https://${NAME}:${port}/page`, init())).rejects.toThrow('private network');
    expect(connectedTo.length).toBe(before);
  });

  it('refuses a certificate it was not told to trust', async () => {
    const untrusting = { ...createNodeDeps(), resolve: async () => ['127.0.0.1'] };
    await expect(createSafeFetch(untrusting, { allowPrivate: true })(`https://${NAME}:${port}/page`, init())).rejects.toThrow();
  });
});
