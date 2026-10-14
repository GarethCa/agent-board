import type { ImageStore } from './image-store.ts';
import {
  domainOf,
  fetchLinkPage,
  linkTrackerRef,
  readCapped,
  type FetchLike,
  type LinkMetadata,
} from './link-metadata.ts';
import type { LinkData } from './protocol.ts';
import type { TrackerHost } from './trackers.ts';

/** The largest favicon kept, in bytes. */
const MAX_FAVICON_BYTES = 256 * 1024;

export interface LinkCardsOptions {
  /** How pages are fetched: `fetch`, by default. */
  fetch?: FetchLike;
  images: ImageStore;
  trackers: Pick<TrackerHost, 'linkTarget'>;
  log: (message: string) => void;
}

/**
 * What the daemon learns about a link card's URL after the card is made: the page's title, domain and favicon, and for
 * an issue or pull request in a tracker a zone is bound to, its state. All best effort: whatever cannot be found is
 * left out, and a card with none of it shows the bare URL.
 */
export function createLinkCards(options: LinkCardsOptions): { enrich(url: string): Promise<Partial<LinkData>> } {
  const { images, trackers, log } = options;
  const fetchLike = options.fetch ?? (globalThis.fetch as FetchLike);

  const favicon = async (url: string): Promise<LinkData['favicon']> => {
    try {
      const response = await fetchLike(url, {
        signal: AbortSignal.timeout(5_000),
        redirect: 'follow',
        headers: { 'user-agent': 'agent-board link preview' },
      });
      if (!response.ok) return undefined;
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_FAVICON_BYTES) return undefined;
      const { bytes, truncated } = await readCapped(response, MAX_FAVICON_BYTES);
      if (bytes.byteLength === 0 || truncated) return undefined;
      return images.put(bytes, { icon: true });
    } catch {
      return undefined;
    }
  };

  return {
    async enrich(url) {
      const ref = linkTrackerRef(url);
      const [page, target] = await Promise.all([
        fetchLinkPage(url, { fetch: fetchLike }) as Promise<Partial<LinkMetadata> & { domain: string }>,
        ref === undefined
          ? undefined
          : trackers.linkTarget(ref).catch((error: Error) => {
              log(`could not look up ${ref.id} for a link card: ${error.message}`);
              return undefined;
            }),
      ]);
      const icon = page.faviconUrl === undefined ? undefined : await favicon(page.faviconUrl);
      const title = target?.title ?? page.title;
      return {
        domain: page.domain ?? domainOf(new URL(url)),
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { favicon: icon }),
        ...(target === undefined || ref === undefined
          ? {}
          : { status: { kind: ref.kind, id: ref.provider === 'github' ? `#${ref.id.split('#')[1]}` : ref.id, state: target.state } }),
      };
    },
  };
}
