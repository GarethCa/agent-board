// A capture window: a hidden board the app opens to take a picture of a zone for an orchestrator. It is framed on the
// zone, shows no terminal's text and only reads the board: the user's view, their sessions and the board stay as they
// are.

/** The zone a capture window draws, the part of the board round it, in board px, and how many window px it gives each one. */
export interface CaptureFrame {
  zoneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** The window query that makes a board window a capture window, holding its frame as JSON. */
export const CAPTURE_QUERY = 'capture';

/** The capture window's frame, from its query; undefined for any other window, or a frame that can't be read. */
export function captureFrameFrom(search: string): CaptureFrame | undefined {
  const text = new URLSearchParams(search).get(CAPTURE_QUERY);
  if (text === null) return undefined;
  try {
    const { zoneId, x, y, width, height, scale } = JSON.parse(text) as Record<string, unknown>;
    const numbers = [x, y, width, height, scale];
    if (typeof zoneId !== 'string' || !numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
    if ((width as number) <= 0 || (height as number) <= 0 || (scale as number) <= 0) return undefined;
    return { zoneId, x, y, width, height, scale } as CaptureFrame;
  } catch {
    return undefined;
  }
}

/** The window's size for `frame`, in whole px. */
export const captureSize = (frame: CaptureFrame) => ({
  width: Math.max(1, Math.round(frame.width * frame.scale)),
  height: Math.max(1, Math.round(frame.height * frame.scale)),
});
