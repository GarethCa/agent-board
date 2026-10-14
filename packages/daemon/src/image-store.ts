import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { invalidParams } from './params.ts';
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, PASTED_IMAGES_DIR, type ImageExtension, type ImageRef } from './protocol.ts';

/** The image format of `bytes` by its magic number, or undefined if it isn't one the board takes. */
export function sniffImage(bytes: Uint8Array): ImageExtension | undefined {
  const starts = (...head: number[]) => head.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'ico';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'webp';
  }
  return undefined;
}

export interface ImageStore {
  /**
   * Stores `bytes`, a PNG, JPEG, GIF or WebP no bigger than `MAX_IMAGE_BYTES` (or, with `icon`, an ICO too); a copy
   * already there is kept once.
   */
  put(bytes: Uint8Array, options?: { icon?: boolean }): ImageRef;
  /** Takes the file at `path`, which must be in `images/incoming`, into the store and removes it. */
  importFile(path: string): ImageRef;
  /** Takes the file at `path` as `importFile` does, and keeps a copy for an agent in `PASTED_IMAGES_DIR`; returns where. */
  pasteFile(path: string): string;
  /** Whether the image is stored. */
  has(ref: ImageRef): boolean;
  /**
   * Spares the image, if stored, from sweeps for the grace period from now, as if just stored: for one whose item was
   * just deleted, so undoing that can make the item again.
   */
  spare(sha256: string): void;
  /** Where the image is on disk. */
  filePath(ref: ImageRef): string;
  /** How long a stored image, or a staged file, is spared by a sweep. */
  readonly graceMs: number;
  /**
   * Deletes the images whose SHA-256 is not in `referenced`, except those stored within the grace period, which an item
   * about to be made may be about to reference; and files left in `incoming/` or half written (`.partial`) by something
   * that died, once they are older than the grace period. Returns how many images it deleted, and how many it spared
   * for being new, which a later sweep should look at again.
   */
  sweep(referenced: ReadonlySet<string>): { removed: number; spared: number };
}

/** An image stored this recently is spared by a sweep: its item is made a moment after it is added. */
const DEFAULT_SWEEP_GRACE_MS = 10 * 60_000;

const STORED_NAME = new RegExp(`^[0-9a-f]{64}\\.(${IMAGE_EXTENSIONS.join('|')})$`);

/**
 * The image store under `<dataDir>/images`: content-addressed files named `<sha256>.<ext>` (ADR-0005 keeps bytes out of
 * SQLite), and `incoming/`, where the app leaves a file for the daemon to take.
 */
export function createImageStore(dataDir: string, options: { graceMs?: number } = {}): ImageStore {
  const root = join(dataDir, 'images');
  const incoming = join(root, 'incoming');
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const filePath = ({ sha256, ext }: ImageRef) => join(root, `${sha256}.${ext}`);

  /** Makes a sweep take the file as just stored. */
  const touch = (file: string) => {
    const now = new Date();
    utimesSync(file, now, now);
  };

  const put = (bytes: Uint8Array, { icon = false } = {}): ImageRef => {
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw invalidParams('an image is over 20 MB');
    const ext = sniffImage(bytes);
    if (ext === undefined || (ext === 'ico' && !icon)) throw invalidParams('an image must be a PNG, JPEG, GIF or WebP');
    const ref = { sha256: createHash('sha256').update(bytes).digest('hex'), ext };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = filePath(ref);
    if (existsSync(target)) {
      // Added again: it is wanted now, so a sweep must spare it again.
      touch(target);
    } else {
      const partial = join(root, `.${randomUUID()}.partial`);
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, target);
    }
    return ref;
  };

  const importFile = (path: string): ImageRef => {
    const inside = relative(incoming, resolve(path));
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw invalidParams('an image to import must be in images/incoming');
    }
    try {
      // Size first, so a huge file is never read.
      if (statSync(path).size > MAX_IMAGE_BYTES) throw invalidParams('an image is over 20 MB');
      return put(readFileSync(path));
    } finally {
      rmSync(path, { force: true });
    }
  };

  return {
    put,
    filePath,
    has: (ref) => existsSync(filePath(ref)),
    spare(sha256) {
      if (!existsSync(root)) return;
      const name = readdirSync(root).find((file) => STORED_NAME.test(file) && file.startsWith(`${sha256}.`));
      if (name !== undefined) touch(join(root, name));
    },
    importFile,
    pasteFile(path) {
      const ref = importFile(path);
      const pasted = join(dataDir, PASTED_IMAGES_DIR);
      mkdirSync(pasted, { recursive: true, mode: 0o700 });
      const target = join(pasted, `${ref.sha256}.${ref.ext}`);
      if (!existsSync(target)) copyFileSync(filePath(ref), target);
      return target;
    },
    graceMs,
    sweep(referenced) {
      const swept = { removed: 0, spared: 0 };
      if (!existsSync(root)) return swept;
      const now = Date.now();
      const isNew = (file: string) => graceMs > 0 && now - statSync(file).mtimeMs < graceMs;
      for (const name of readdirSync(root)) {
        const file = join(root, name);
        if (name.endsWith('.partial')) {
          if (!isNew(file)) rmSync(file, { force: true });
        } else if (STORED_NAME.test(name) && !referenced.has(name.slice(0, 64))) {
          if (isNew(file)) swept.spared++;
          else {
            rmSync(file, { force: true });
            swept.removed++;
          }
        }
      }
      if (existsSync(incoming)) {
        for (const name of readdirSync(incoming)) {
          const file = join(incoming, name);
          if (!isNew(file)) rmSync(file, { force: true });
        }
      }
      return swept;
    },
  };
}
