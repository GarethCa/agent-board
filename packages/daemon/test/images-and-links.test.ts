import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, describe, expect, it } from 'vitest';
import { createGitHubTracker } from '@agent-board/tracker';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import type { DaemonClient } from '../src/client.ts';
import type { FetchLike } from '../src/link-metadata.ts';
import { MAX_IMAGE_BYTES, PASTED_IMAGES_DIR, RPC_ERROR, type CreateItemParams, type ImageRef, type LinkData } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('one')]);
const OTHER_PNG = Buffer.concat([PNG.subarray(0, 8), Buffer.from('two')]);
const ICON = Buffer.from([0, 0, 1, 0, 1, 0, 9, 9]);
const PAGE = readFileSync(new URL('./fixtures/article.html', import.meta.url), 'utf8');

/** A daemon with no wait before the sweep may delete an unused image. */
async function imageDaemon(options: Parameters<typeof startTestDaemon>[0] = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  const daemon = await startTestDaemon({ imageSweepGraceMs: 0, ...options, dataDir });
  const client = await connectTestClient(daemon);
  const stored = () =>
    (existsSync(join(dataDir, 'images')) ? readdirSync(join(dataDir, 'images')) : []).filter((name) => /^[0-9a-f]{64}\./.test(name)).sort();
  /** Stages `bytes` in images/incoming, as the app does, and imports them. */
  const importImage = async (bytes: Buffer, name = `upload-${Math.random()}`): Promise<ImageRef> => {
    const incoming = join(dataDir, 'images', 'incoming');
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, name), bytes);
    return client.call('image.import', { path: join(incoming, name) });
  };
  return { daemon, dataDir, client, stored, importImage };
}

const imageItem = (ref: ImageRef, overrides: Partial<CreateItemParams> = {}): CreateItemParams => ({
  kind: 'image',
  zoneId: null,
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  data: { ...ref },
  ...overrides,
});

const linkItem = (url: string): CreateItemParams => ({
  kind: 'link',
  zoneId: null,
  x: 0,
  y: 0,
  width: 280,
  height: 96,
  data: { url },
});

describe('image items', () => {
  it('stores imported bytes once however many items show them', async () => {
    const { client, stored, importImage } = await imageDaemon();

    const first = await importImage(PNG);
    const second = await importImage(PNG);
    await client.call('item.create', imageItem(first));
    await client.call('item.create', imageItem(second, { x: 400 }));

    expect(second).toEqual(first);
    expect(stored()).toEqual([`${first.sha256}.png`]);
  });

  it('refuses a file over 20 MB, a non-image, and a path outside images/incoming', async () => {
    const { dataDir, client, stored, importImage } = await imageDaemon();
    const invalid = { code: RPC_ERROR.invalidParams };
    writeFileSync(join(dataDir, 'elsewhere.png'), PNG);

    await expect(importImage(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).rejects.toThrow('over 20 MB');
    await expect(importImage(Buffer.from('not an image'))).rejects.toMatchObject(invalid);
    await expect(client.call('image.import', { path: join(dataDir, 'elsewhere.png') })).rejects.toThrow('images/incoming');
    expect(stored()).toEqual([]);
  });

  it('keeps an image pasted for an agent in a folder of its own, where the agent can read it', async () => {
    const { dataDir, client } = await imageDaemon();
    const incoming = join(dataDir, 'images', 'incoming');
    mkdirSync(incoming, { recursive: true });
    const paste = (bytes: Buffer, name: string) => {
      writeFileSync(join(incoming, name), bytes);
      return client.call('image.paste', { path: join(incoming, name) });
    };

    const { path } = await paste(PNG, 'screenshot');
    expect(path).toMatch(new RegExp(`^${join(dataDir, PASTED_IMAGES_DIR)}/[0-9a-f]{64}\\.png$`));
    expect(readFileSync(path)).toEqual(PNG);
    expect(readdirSync(incoming)).toEqual([]);
    // Pasted again, the same file.
    expect(await paste(PNG, 'again')).toEqual({ path });

    await expect(paste(Buffer.from('not an image'), 'text')).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(client.call('image.paste', { path: join(dataDir, 'elsewhere.png') })).rejects.toThrow('images/incoming');
  });

  it('refuses an image item whose image is not stored', async () => {
    const { client } = await imageDaemon();
    const missing = { sha256: 'a'.repeat(64), ext: 'png' as const };

    await expect(client.call('item.create', imageItem(missing))).rejects.toThrow('is not stored');
    await expect(client.call('item.create', imageItem({ sha256: 'xyz', ext: 'png' }))).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('item.create', imageItem({ sha256: 'a'.repeat(64), ext: 'svg' as never }))).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it("deletes an image's file with its last item, not before", async () => {
    const { client, stored, importImage } = await imageDaemon();
    const ref = await importImage(PNG);
    const one = await client.call('item.create', imageItem(ref));
    const two = await client.call('item.create', imageItem(ref, { x: 400 }));

    await client.call('item.delete', { id: one.id });
    expect(stored()).toEqual([`${ref.sha256}.png`]);

    await client.call('item.delete', { id: two.id });
    expect(stored()).toEqual([]);
  });

  it('deletes an image deleted soon after it was stored once its grace is over, without another delete or a restart', async () => {
    const { client, stored, importImage } = await imageDaemon({ imageSweepGraceMs: 300 });
    const ref = await importImage(PNG);
    const item = await client.call('item.create', imageItem(ref));

    await client.call('item.delete', { id: item.id });
    // Spared: it is still new.
    expect(stored()).toEqual([`${ref.sha256}.png`]);

    for (let tries = 0; tries < 100 && stored().length > 0; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored()).toEqual([]);
  });

  it("keeps a deleted item's image for the grace, so undoing the delete can make it again", async () => {
    const { client, dataDir, stored, importImage } = await imageDaemon({ imageSweepGraceMs: 60_000 });
    const ref = await importImage(PNG);
    const item = await client.call('item.create', imageItem(ref));
    // Stored long before it is deleted: past the grace that spares a new image.
    const file = join(dataDir, 'images', `${ref.sha256}.png`);
    const longAgo = new Date(Date.now() - 120_000);
    utimesSync(file, longAgo, longAgo);

    // The delete sweeps, and spares it.
    await client.call('item.delete', { id: item.id });
    expect(stored()).toEqual([`${ref.sha256}.png`]);
    await client.call('item.create', imageItem(ref, { id: item.id }));
  });

  it('refuses to point an image at a file that is not stored, in a patch of the sha256 alone too', async () => {
    const { client, importImage } = await imageDaemon();
    const ref = await importImage(PNG);
    const item = await client.call('item.create', imageItem(ref));

    await expect(client.call('item.update', { id: item.id, data: { sha256: 'b'.repeat(64) } })).rejects.toThrow('is not stored');
    expect((await client.call('item.list'))[0]!.data).toEqual({ ...ref });
  });

  it('sweeps images nothing references when the daemon starts, keeping those an item shows', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir, imageSweepGraceMs: 0 });
    const client = await connectTestClient(first);
    const incoming = join(dataDir, 'images', 'incoming');
    mkdirSync(incoming, { recursive: true });
    const importImage = async (bytes: Buffer, name: string) => {
      writeFileSync(join(incoming, name), bytes);
      return client.call('image.import', { path: join(incoming, name) });
    };
    const kept = await importImage(PNG, 'a');
    await client.call('item.create', imageItem(kept));
    // An orphan the first daemon's own sweeps spared, as one left by a crash between an import and its item.
    const orphan = await importImage(OTHER_PNG, 'b');
    client.close();
    await first.stop();

    await startTestDaemon({ dataDir, imageSweepGraceMs: 0 });

    const left = readdirSync(join(dataDir, 'images')).filter((name) => /^[0-9a-f]{64}\./.test(name));
    expect(left).toEqual([`${kept.sha256}.png`]);
    expect(left).not.toContain(`${orphan.sha256}.png`);
  });
});

describe('link cards', () => {
  const pages = (answers: Record<string, () => Response>): FetchLike => async (url) => {
    const answer = answers[url];
    return answer === undefined ? new Response('', { status: 404 }) : answer();
  };
  const html = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/html' } });

  /** The card once it has more than its URL. */
  async function filled(client: DaemonClient, id: string): Promise<LinkData> {
    for (let tries = 0; tries < 200; tries++) {
      const item = (await client.call('item.list')).find((found) => found.id === id)!;
      const data = item.data as unknown as LinkData;
      if (data.domain !== undefined) return data;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the link card was not filled in');
  }

  it('shows the bare URL at once, then fills in the title, domain and a stored favicon', async () => {
    const fetch = pages({
      'https://www.example.com/posts/1': html(PAGE),
      'https://www.example.com/static/favicon-32.png': () => new Response(ICON),
    });
    const { client, stored } = await imageDaemon({ linkFetch: fetch });

    const card = await client.call('item.create', linkItem('https://www.example.com/posts/1'));
    expect(card.data).toEqual({ url: 'https://www.example.com/posts/1' });

    const data = await filled(client, card.id);
    expect(data).toMatchObject({ title: 'Why boards beat terminals — a field note', domain: 'example.com' });
    expect(data.favicon).toMatchObject({ ext: 'ico' });
    expect(stored()).toEqual([`${data.favicon!.sha256}.ico`]);
  });

  it('keeps no favicon that is over 256 KB, however it is sent', async () => {
    const big = Buffer.concat([ICON, Buffer.alloc(300 * 1024)]);
    const fetch = pages({
      'https://www.example.com/posts/1': html(PAGE),
      'https://www.example.com/static/favicon-32.png': () => new Response(big),
    });
    const { client, stored } = await imageDaemon({ linkFetch: fetch });

    const card = await client.call('item.create', linkItem('https://www.example.com/posts/1'));

    const data = await filled(client, card.id);
    expect(data.title).toBeDefined();
    expect(data.favicon).toBeUndefined();
    expect(stored()).toEqual([]);
  });

  it('keeps just the domain when the page cannot be fetched', async () => {
    const { client } = await imageDaemon({ linkFetch: pages({}) });

    const card = await client.call('item.create', linkItem('https://offline.example.org/x'));

    expect(await filled(client, card.id)).toEqual({ url: 'https://offline.example.org/x', domain: 'offline.example.org' });
  });

  it('reads a card whose page was never read again when the daemon next starts', async () => {
    const dataDir = tempDataDir();
    const never: FetchLike = () => new Promise(() => {});
    const first = await imageDaemon({ dataDir, linkFetch: never });
    const card = await first.client.call('item.create', linkItem('https://www.example.com/posts/1'));
    first.client.close();
    await first.daemon.stop();

    const second = await imageDaemon({ dataDir, linkFetch: pages({ 'https://www.example.com/posts/1': html(PAGE) }) });

    expect(await filled(second.client, card.id)).toMatchObject({ title: 'Why boards beat terminals — a field note' });
  });

  it('takes only https URLs', async () => {
    const { client } = await imageDaemon({ linkFetch: pages({}) });
    const invalid = { code: RPC_ERROR.invalidParams };

    await expect(client.call('item.create', linkItem('http://example.com/'))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', linkItem('file:///etc/passwd'))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', linkItem('javascript:alert(1)'))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', linkItem('not a url'))).rejects.toMatchObject(invalid);
  });

  it("shows an issue's or pull request's state when a zone is bound to its repo", async () => {
    const github = createFakeGitHub({
      ...FAKE_GITHUB_STATE,
      pullRequests: [
        { repo: 'acme/app', number: 7, title: 'Add search', headRefName: 'search', state: 'MERGED', isDraft: false, statusCheckRollup: [] },
      ],
    });
    onTestFinished(github.dispose);
    const { client } = await imageDaemon({
      linkFetch: pages({}),
      trackers: { github: () => createGitHubTracker({ gh: github.gh }) },
    });
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'github', scope: 'acme/app' } });

    const issue = await client.call('item.create', linkItem('https://github.com/acme/app/issues/34'));
    const pr = await client.call('item.create', linkItem('https://github.com/acme/app/pull/7'));
    const elsewhere = await client.call('item.create', linkItem('https://github.com/other/repo/issues/1'));

    expect(await filled(client, issue.id)).toMatchObject({
      title: 'Fix the login redirect',
      status: { kind: 'issue', id: '#34', state: 'Open' },
    });
    expect(await filled(client, pr.id)).toMatchObject({ title: 'Add search', status: { kind: 'pr', id: '#7', state: 'Merged' } });
    expect((await filled(client, elsewhere.id)).status).toBeUndefined();
  });
});

describe('the image store on disk', () => {
  it('keeps nothing in images/incoming after an import', async () => {
    const { dataDir, importImage } = await imageDaemon();
    await importImage(PNG, 'a');
    expect(existsSync(join(dataDir, 'images', 'incoming', 'a'))).toBe(false);
  });
});
