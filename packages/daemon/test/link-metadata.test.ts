import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fetchLinkPage,
  readCapped,
  linkTrackerRef,
  parseLinkMetadata,
  type FetchLike,
} from '../src/link-metadata.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseLinkMetadata', () => {
  it('takes og:title over <title>, and the icon link, resolved against the page URL', () => {
    expect(parseLinkMetadata(fixture('article.html'), 'https://www.example.com/posts/1')).toEqual({
      title: 'Why boards beat terminals — a field note',
      domain: 'example.com',
      faviconUrl: 'https://www.example.com/static/favicon-32.png',
    });
  });

  it('reads <title> and an icon link written another way', () => {
    expect(parseLinkMetadata(fixture('plain.html'), 'https://docs.example.org/a/b')).toEqual({
      title: 'Plain page',
      domain: 'docs.example.org',
      faviconUrl: 'https://docs.example.org/a/icon.ico',
    });
  });

  it('ignores script and comments, and decodes entities in a title', () => {
    const html = '<script>"<title>no</title>"</script><!-- <title>no</title> --><title>A &amp; B &#169;</title>';
    expect(parseLinkMetadata(html, 'https://x.test/').title).toBe('A & B ©');
  });

  it('falls back to /favicon.ico, and to no title', () => {
    expect(parseLinkMetadata('<html></html>', 'https://x.test/deep/page')).toEqual({
      domain: 'x.test',
      faviconUrl: 'https://x.test/favicon.ico',
    });
  });

  it('refuses an icon that is not an https URL, so it is never fetched over http or from a script URL', () => {
    for (const href of ['javascript:alert(1)', 'http://127.0.0.1:8080/icon.png', 'http://x.test/icon.png', 'data:image/png;base64,AAAA']) {
      expect(parseLinkMetadata(`<link rel="icon" href="${href}">`, 'https://x.test/').faviconUrl, href).toBe(
        'https://x.test/favicon.ico',
      );
    }
  });
});

describe('fetchLinkPage', () => {
  const reply = (body: string, init: ResponseInit = {}): Response =>
    new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

  it('fetches the page and parses it', async () => {
    const fetch: FetchLike = async () => reply(fixture('plain.html'));
    expect(await fetchLinkPage('https://docs.example.org/', { fetch })).toMatchObject({ title: 'Plain page' });
  });

  it('gives only the domain when the fetch fails, is not HTML, or times out', async () => {
    const bare = { domain: 'x.test' };
    expect(await fetchLinkPage('https://x.test/', { fetch: async () => Promise.reject(new Error('offline')) })).toEqual(bare);
    expect(await fetchLinkPage('https://x.test/', { fetch: async () => reply('x', { status: 500 }) })).toEqual(bare);
    expect(
      await fetchLinkPage('https://x.test/', {
        fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      }),
    ).toEqual(bare);
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await fetchLinkPage('https://x.test/', { fetch: hang, timeoutMs: 20 })).toEqual(bare);
  });

  it('reads a page in the charset its content type names', async () => {
    const latin1 = Buffer.from('<title>Caf\xe9 au lait</title>', 'latin1');
    const fetch: FetchLike = async () => new Response(latin1, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } });
    expect((await fetchLinkPage('https://x.test/', { fetch })).title).toBe('Café au lait');
    const meta = Buffer.from('<meta charset="windows-1252"><title>Caf\xe9</title>', 'latin1');
    const byMeta: FetchLike = async () => new Response(meta, { headers: { 'content-type': 'text/html' } });
    expect((await fetchLinkPage('https://x.test/', { fetch: byMeta })).title).toBe('Café');
  });

  it('reads at most the start of a page, where the head is', async () => {
    const page = `<title>Big</title>${'x'.repeat(2_000_000)}`;
    const result = await fetchLinkPage('https://x.test/', { fetch: async () => reply(page), maxBytes: 1000 });
    expect(result.title).toBe('Big');
  });
});

describe('linkTrackerRef', () => {
  it('names a Linear issue by its team key', () => {
    expect(linkTrackerRef('https://linear.app/acme/issue/ACME-49/images-and-link-cards')).toEqual({
      provider: 'linear',
      scope: 'ACME',
      id: 'ACME-49',
      kind: 'issue',
    });
  });

  it('names a GitHub issue or pull request by its repo and number', () => {
    expect(linkTrackerRef('https://github.com/acme/app/issues/34')).toEqual({
      provider: 'github',
      scope: 'acme/app',
      id: 'acme/app#34',
      kind: 'issue',
    });
    expect(linkTrackerRef('https://github.com/acme/app/pull/7/files')).toEqual({
      provider: 'github',
      scope: 'acme/app',
      id: 'acme/app#7',
      kind: 'pr',
    });
  });

  it('knows www.github.com too', () => {
    expect(linkTrackerRef('https://www.github.com/acme/app/issues/3')).toMatchObject({ scope: 'acme/app', id: 'acme/app#3' });
  });

  it('names nothing else', () => {
    expect(linkTrackerRef('https://github.com/acme/app')).toBeUndefined();
    expect(linkTrackerRef('https://example.com/issues/3')).toBeUndefined();
    expect(linkTrackerRef('https://linear.app/acme/project/x')).toBeUndefined();
  });
});

describe('readCapped', () => {
  it('stops reading a body that goes on past the cap, and says so', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1000));
      },
    });
    const { bytes, truncated } = await readCapped(new Response(body), 2500);
    expect(truncated).toBe(true);
    expect(bytes.byteLength).toBe(2500);
    expect(pulled).toBeLessThan(10);
  });

  it('gives a short body whole', async () => {
    expect(await readCapped(new Response('abc'), 100)).toEqual({ bytes: Buffer.from('abc'), truncated: false });
  });
});
