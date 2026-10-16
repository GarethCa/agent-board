import { useCallback, useEffect, type DragEvent, type RefObject } from 'react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import { BOARD_CLIPBOARD_TYPE } from './editing/clipboard';
import type { ItemKind } from './items/kinds';
import { classifyDrop, classifyPaste, imageBoardSize, imageProblem, type Incoming } from './items/paste';
import { isTyping } from './use-tile-moves';

type Point = { x: number; y: number };

interface IncomingOptions {
  loaded: boolean;
  /** Adds a new item of `kind` centred on board position `centre`; its id. */
  createItem(kind: BoardItemKind, centre: Point, made?: { size?: ItemKind['size']; data?: Record<string, unknown> }): string;
  /** Shows why `action` failed. */
  report(action: string): (error: unknown) => void;
  /** Pastes board items copied here or in another window, from the clipboard's board data; whether there were any. */
  pasteItems(data: string): boolean;
  /** Where the pointer last was over the board, in screen coordinates. */
  pointer: RefObject<Point | undefined>;
  /** The board position in the middle of the window. */
  boardCentre(): Point;
  screenToFlowPosition(point: Point): Point;
}

/**
 * What a paste or a drop brings onto the board that isn't board items: an image item per image file, its bytes in the
 * daemon's image store, or a link card for a pasted link. Returns `onFilesDropped`, for the board's drop.
 */
export function useIncoming({ loaded, createItem, report, pasteItems, pointer, boardCentre, screenToFlowPosition }: IncomingOptions) {
  /** Adds `file` as an image item centred on `centre`: its bytes go to the daemon's image store first. */
  const addImage = useCallback(
    async (file: File, centre: Point) => {
      try {
        const problem = imageProblem(file);
        if (problem !== undefined) throw new Error(problem);
        // Decoded here for its size; a file the browser can't decode is not an image the board can show.
        const bitmap = await createImageBitmap(file);
        const natural = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const ref = await window.agentBoard.items.importImage(await file.arrayBuffer());
        createItem('image', centre, { size: imageBoardSize(natural), data: { ...ref } });
      } catch (error) {
        report('add the image')(error);
      }
    },
    [createItem, report],
  );

  /** Adds what a paste or drop brought, one item per image, each a little way from the last. */
  const addIncoming = useCallback(
    (incoming: Incoming, centre: Point) => {
      if (incoming.type === 'images') {
        incoming.files.forEach((file, n) => void addImage(file, { x: centre.x + n * 24, y: centre.y + n * 24 }));
      } else if (incoming.type === 'link') {
        createItem('link', centre, { data: { url: incoming.url } });
      } else if (incoming.type === 'refused') {
        report('add it')(incoming.reason);
      }
    },
    [addImage, createItem, report],
  );

  // Paste adds an image or a link at the pointer, or in the middle of the board; not while typing into a field.
  useEffect(() => {
    if (!loaded) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(event) || event.clipboardData === null) return;
      // Board items copied here or in another window.
      if (pasteItems(event.clipboardData.getData(BOARD_CLIPBOARD_TYPE))) return event.preventDefault();
      const incoming = classifyPaste({
        files: [...event.clipboardData.files],
        text: event.clipboardData.getData('text/plain'),
      });
      if (incoming.type === 'nothing') return;
      event.preventDefault();
      addIncoming(incoming, pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loaded, addIncoming, boardCentre, screenToFlowPosition, pasteItems]);

  /** Adds the files dropped on the board where they were let go; a drop without files is left alone. */
  const onFilesDropped = useCallback(
    (event: DragEvent) => {
      if (event.dataTransfer.files.length === 0) return;
      // Not for the window to open the file.
      event.preventDefault();
      addIncoming(classifyDrop([...event.dataTransfer.files]), screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addIncoming, screenToFlowPosition],
  );

  return { onFilesDropped };
}
