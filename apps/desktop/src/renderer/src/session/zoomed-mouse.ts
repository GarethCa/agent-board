import type { Terminal } from '@xterm/xterm';

interface Point {
  clientX: number;
  clientY: number;
}

/** The slice of xterm's (private) mouse service this patches. */
interface MouseService {
  getCoords(event: Point, element: HTMLElement, ...rest: unknown[]): unknown;
  getMouseReportCoords(event: Point, element: HTMLElement): unknown;
}

/**
 * The point as it would be with the element unscaled: rescaled about the element's on-screen origin by the inverse of
 * the CSS scale it sits under (on-screen size ÷ layout size).
 */
export function unscalePoint(event: Point, element: HTMLElement): Point {
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  if (!(scaleX > 0 && scaleY > 0 && Number.isFinite(scaleX) && Number.isFinite(scaleY))) return event;
  return {
    clientX: rect.left + (event.clientX - rect.left) / scaleX,
    clientY: rect.top + (event.clientY - rect.top) / scaleY,
  };
}

/**
 * Makes a terminal's mouse selection and mouse reports land on the right cell under a CSS-scaled ancestor, as the
 * board's zoom is. xterm sizes its cells unscaled but divides the pointer's offset from the *scaled* on-screen
 * box by them. Wrapping the mouse service covers every path that maps a pointer to a cell, including the document-level
 * listeners xterm adds while a selection is dragged. Needs the terminal to be open; xterm is pinned, as this reaches
 * into its internals.
 */
export function compensateForScale(terminal: Terminal): void {
  const service = (terminal as unknown as { _core?: { _mouseService?: MouseService } })._core?._mouseService;
  if (!service) {
    // xterm moved its internals (an upgrade): selection is off under zoom again. zoomed-mouse.test.ts pins the shape.
    console.warn('zoomed-mouse: xterm has no _core._mouseService; mouse selection is not compensated for zoom');
    return;
  }
  const getCoords = service.getCoords.bind(service);
  const getMouseReportCoords = service.getMouseReportCoords.bind(service);
  service.getCoords = (event, element, ...rest) => getCoords(unscalePoint(event, element), element, ...rest);
  service.getMouseReportCoords = (event, element) => getMouseReportCoords(unscalePoint(event, element), element);
}
