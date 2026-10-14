import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createImageStore, sniffImage } from '../src/image-store.ts';
import { MAX_IMAGE_BYTES } from '../src/protocol.ts';
import { tempDataDir } from './helpers.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('one')]);
const OTHER_PNG = Buffer.concat([PNG.subarray(0, 8), Buffer.from('two')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('sniffImage', () => {
  it('names the format from the magic bytes, not from any file name', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
  });

  it('refuses everything else, SVG included', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('hello'))).toBeUndefined();
  });
});

describe('the image store', () => {
  it('keeps an image under images/<sha256>.<ext>, once however often it is added', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir);

    const first = store.put(PNG);
    const again = store.put(PNG);

    expect(again).toEqual(first);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, 'images')).filter((name) => name.endsWith('.png'))).toEqual([`${first.sha256}.png`]);
    expect(readFileSync(store.filePath(first))).toEqual(PNG);
  });

  it('imports a file from images/incoming, moving it away', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir);
    mkdirSync(join(dir, 'images', 'incoming'), { recursive: true });
    const staged = join(dir, 'images', 'incoming', 'upload-1');
    writeFileSync(staged, JPEG);

    const ref = store.importFile(staged);

    expect(ref.ext).toBe('jpg');
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(store.filePath(ref))).toEqual(JPEG);
  });

  it('refuses a file outside images/incoming, however it is spelled', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir);
    const outside = join(dir, 'secret.png');
    writeFileSync(outside, PNG);
    mkdirSync(join(dir, 'images', 'incoming'), { recursive: true });

    expect(() => store.importFile(outside)).toThrow('images/incoming');
    expect(() => store.importFile(join(dir, 'images', 'incoming', '..', '..', 'secret.png'))).toThrow('images/incoming');
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses a file over 20 MB or of another format, and removes it', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir);
    mkdirSync(join(dir, 'images', 'incoming'), { recursive: true });
    const big = join(dir, 'images', 'incoming', 'big');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    const text = join(dir, 'images', 'incoming', 'text');
    writeFileSync(text, 'not an image');

    expect(() => store.importFile(big)).toThrow('over 20 MB');
    expect(() => store.importFile(text)).toThrow('PNG, JPEG, GIF or WebP');
    expect(readdirSync(join(dir, 'images', 'incoming'))).toEqual([]);
  });

  it('sweeps the images nothing references, and no others', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir, { graceMs: 0 });
    const kept = store.put(PNG);
    const orphan = store.put(OTHER_PNG);

    expect(store.sweep(new Set([kept.sha256]))).toEqual({ removed: 1, spared: 0 });

    expect(existsSync(store.filePath(kept))).toBe(true);
    expect(existsSync(store.filePath(orphan))).toBe(false);
  });

  it('spares a new image for a while, so one added just before its item is made is not swept', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir, { graceMs: 60_000 });
    const fresh = store.put(PNG);
    const old = store.put(OTHER_PNG);
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(store.filePath(old), longAgo, longAgo);

    expect(store.sweep(new Set())).toEqual({ removed: 1, spared: 1 });

    expect(existsSync(store.filePath(fresh))).toBe(true);
    expect(existsSync(store.filePath(old))).toBe(false);
  });

  it('starts the grace again when an image already stored is added again', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir, { graceMs: 60_000 });
    const ref = store.put(PNG);
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(store.filePath(ref), longAgo, longAgo);

    store.put(PNG);
    store.sweep(new Set());

    expect(existsSync(store.filePath(ref))).toBe(true);
  });

  it('deletes files a crash left in images/incoming or half written, once they are older than the grace', () => {
    const dir = tempDataDir();
    const store = createImageStore(dir, { graceMs: 60_000 });
    store.put(PNG);
    const incoming = join(dir, 'images', 'incoming');
    mkdirSync(incoming, { recursive: true });
    const files = {
      staleStaged: join(incoming, 'old'),
      freshStaged: join(incoming, 'new'),
      stalePartial: join(dir, 'images', '.old.partial'),
      freshPartial: join(dir, 'images', '.new.partial'),
    };
    for (const file of Object.values(files)) writeFileSync(file, 'x');
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(files.staleStaged, longAgo, longAgo);
    utimesSync(files.stalePartial, longAgo, longAgo);

    store.sweep(new Set());

    expect(existsSync(files.staleStaged)).toBe(false);
    expect(existsSync(files.stalePartial)).toBe(false);
    expect(existsSync(files.freshStaged)).toBe(true);
    expect(existsSync(files.freshPartial)).toBe(true);
  });
});
