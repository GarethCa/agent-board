import { MAX_IMAGE_BYTES, MAX_LINK_URL } from '@agent-board/daemon/protocol';

/** What a paste or drop brings to the board. */
export type Incoming =
  | { type: 'images'; files: File[] }
  | { type: 'link'; url: string }
  /** Something the board won't take, and why, in words for a toast: "Could not add the link: <reason>". */
  | { type: 'refused'; reason: string }
  | { type: 'nothing' };

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;

/** Whether `file` is an image the board takes by its type. The daemon checks the bytes. */
const isBoardImage = (file: { type: string }): boolean => IMAGE_TYPE.test(file.type);

/** The first problem with adding `file` as an image, in words for a toast, or undefined. */
export function imageProblem(file: { type: string; size: number }): string | undefined {
  if (!isBoardImage(file)) return 'only PNG, JPEG, GIF and WebP images can be added';
  if (file.size > MAX_IMAGE_BYTES) return 'the image is over 20 MB';
  return undefined;
}

/** The URL `text` is, when it is one URL and nothing else. */
function singleUrl(text: string): URL | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return undefined;
  try {
    return new URL(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Sorts a paste's contents: image files first, else a single URL. Only https links are taken, as only those open in the
 * browser from the app (`openWebLink`); any other text is left to whatever is focused.
 */
export function classifyPaste(data: { files: readonly File[]; text: string }): Incoming {
  const images = data.files.filter((file) => file.type.startsWith('image/'));
  if (images.length > 0) return { type: 'images', files: images };
  const url = singleUrl(data.text);
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) return { type: 'nothing' };
  if (url.protocol === 'http:') return { type: 'refused', reason: 'only https links can be added' };
  if (url.href.length > MAX_LINK_URL) return { type: 'refused', reason: 'the link is too long' };
  return { type: 'link', url: url.href };
}

/** What a drop of files brings: its images; other files are refused. */
export function classifyDrop(files: readonly File[]): Incoming {
  if (files.length === 0) return { type: 'nothing' };
  const images = files.filter((file) => file.type.startsWith('image/'));
  return images.length > 0 ? { type: 'images', files: images } : { type: 'refused', reason: 'only images can be dropped on the board' };
}

/** An image's size on the board: its own, shrunk to fit `limit` on its longer side, never grown. */
export function imageBoardSize(natural: { width: number; height: number }, limit = 360): { width: number; height: number } {
  const longer = Math.max(natural.width, natural.height);
  const scale = longer > limit ? limit / longer : 1;
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}
