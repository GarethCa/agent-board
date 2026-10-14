import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES } from '@agent-board/daemon/protocol';

/**
 * Hands an image's `bytes` to the daemon: written to `images/incoming`, then given to `take` (`image.import` or
 * `image.paste`) by path. The daemon takes the file from there and checks it: it, not the app, decides what it keeps.
 */
export async function handImage<T>(dataDir: string, bytes: unknown, take: (path: string) => Promise<T>): Promise<T> {
  if (!(bytes instanceof ArrayBuffer)) throw new Error('an image is bytes');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('the image is over 20 MB');
  const incoming = join(dataDir, 'images', 'incoming');
  mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const staged = join(incoming, crypto.randomUUID());
  writeFileSync(staged, new Uint8Array(bytes), { mode: 0o600 });
  try {
    return await take(staged);
  } catch (error) {
    // The daemon removes what it was given, but not when it never got to it.
    rmSync(staged, { force: true });
    throw error;
  }
}
