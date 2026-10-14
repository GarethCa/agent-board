import type { DatabaseSync } from 'node:sqlite';
import type { ImageStore } from './image-store.ts';

/** The SHA-256s of the stored images an item's data references: an image item's image, or a link card's favicon. */
export function imagesOf(data: { sha256?: unknown; favicon?: { sha256?: unknown } }): string[] {
  return [data.sha256, data.favicon?.sha256].filter((sha): sha is string => typeof sha === 'string');
}

/** The SHA-256s of the stored images the items reference. */
export function referencedImages(rows: { data: string }[]): Set<string> {
  return new Set(rows.flatMap((row) => imagesOf(JSON.parse(row.data) as Parameters<typeof imagesOf>[0])));
}

export interface ImageSweeper {
  /** Deletes the stored images no item references. One stored a moment ago is spared, and swept once its grace is over. */
  sweep(): void;
  /** Cancels the sweep waiting to run. */
  stop(): void;
}

/**
 * Sweeps the image store of what no board item references, now and whenever asked. An image just stored is spared,
 * since its item is made a moment later; when a sweep spares one, another follows once its grace is over, so an image
 * deleted soon after it was pasted doesn't wait for the next delete or restart to go.
 */
export function createImageSweeper(db: DatabaseSync, images: ImageStore, log: (message: string) => void): ImageSweeper {
  const imageData = db.prepare("SELECT data FROM board_items WHERE kind IN ('image', 'link')");
  let later: ReturnType<typeof setTimeout> | undefined;
  const sweeper: ImageSweeper = {
    sweep() {
      clearTimeout(later);
      later = undefined;
      try {
        const { spared } = images.sweep(referencedImages(imageData.all() as { data: string }[]));
        if (spared > 0) {
          later = setTimeout(sweeper.sweep, images.graceMs + 500);
          later.unref();
        }
      } catch (error) {
        log(`could not sweep unused images: ${(error as Error).message}`);
      }
    },
    stop() {
      clearTimeout(later);
      later = undefined;
    },
  };
  return sweeper;
}
