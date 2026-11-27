// The rules a full screen and the objects that open one share, apart from their drawing.

/** What a press on a folded object's icon does: one click opens its peek, a second (a double-click) opens it full screen. A key's press (no clicks) opens the peek. */
export function iconPress(clicks: number, hasFull: boolean): 'peek' | 'full' {
  return hasFull && clicks >= 2 ? 'full' : 'peek';
}

/** Where the focus goes as a full screen closes: back where it was as it opened, else to the object it shows. */
export function focusBack(opener: HTMLElement | null, object: () => HTMLElement | null | undefined): HTMLElement | null | undefined {
  return opener?.isConnected === true ? opener : object();
}
