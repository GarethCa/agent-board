import type { ImageRef } from '@agent-board/daemon/protocol';

/** The scheme the app serves stored images under (see `registerImageProtocol` in the main process). */
export const IMAGE_SCHEME = 'agent-board-image';

/** Where the renderer loads a stored image from. */
export const imageUrl = ({ sha256, ext }: ImageRef): string => `${IMAGE_SCHEME}://${sha256}.${ext}`;
