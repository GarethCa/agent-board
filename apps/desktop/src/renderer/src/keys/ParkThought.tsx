import { useEffect, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { MessageCircleDashed } from 'lucide-react';
import { SESSION_SURFACES } from '../board/board-shortcuts';
import { focusKeeper } from '../chrome/Spotlight';
import { errorMessage } from '../../../shared/errors';
import { Kbd, useToast } from '../ui';
import { inOverlay } from '.';
import { onParkThought, parkLine, parkThought, unpark } from './park-thought';
import { pressed } from './registry';

/**
 * Park a thought: ⌘⇧P (or ⌘K's Park a thought), from anywhere in the window, a terminal or a session window too, opens
 * a one-line field. ↵ puts the line at the back of the user's queue and gives the focus back to exactly what had it; Esc,
 * or an empty line, parks nothing. The toast that says where it went takes it back; a line that can't be parked is kept
 * in the toast that says so. ⌘⇧P again while it is open leaves it open, with what is typed, its focus back in the line.
 */
export function ParkThought() {
  const [restore, setRestore] = useState<() => void>();
  const [text, setText] = useState('');
  const toasts = useToast();
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const show = (back: () => void) => {
      setText('');
      setRestore(() => back);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.parkThought', event)) return;
      const open = restoreRef.current;
      // Another dialog or menu keeps its keys; a session window, a dialog too, is where it opens from.
      if (open === undefined && inOverlay() && document.activeElement?.closest(SESSION_SURFACES) == null) return;
      event.preventDefault();
      event.stopPropagation();
      if (open !== undefined) input.current?.focus();
      // A key handed over from a web tab's page (or a plan's) is dispatched on its host; any other is the focus's.
      else show(focusKeeper(event.target instanceof Element && event.target !== document.body ? event.target : document.activeElement));
    };
    // Before the terminal's keys, wherever the focus is.
    window.addEventListener('keydown', onKeyDown, true);
    const off = onParkThought(show);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      off();
    };
  }, []);

  function close(back: () => void) {
    setRestore(undefined);
    requestAnimationFrame(back);
  }

  function park() {
    if (restore === undefined) return;
    close(restore);
    const line = parkLine(text);
    if (line === null) return;
    parkThought(window.agentBoard, line).then(
      (parked) =>
        toasts.show({
          id: 'park a thought',
          tone: 'success',
          message: parked.made ? 'Parked in a new “To look at” queue, right of the board' : 'Parked at the back of your queue',
          action: {
            label: 'Undo',
            onClick: () => void unpark(window.agentBoard, parked).catch((error: unknown) => toasts.show({ id: 'park a thought', tone: 'error', message: `Could not take “${line}” back: ${errorMessage(error)}` })),
          },
        }),
      (error: unknown) => toasts.show({ id: 'park a thought', tone: 'error', message: `Could not park “${line}”: ${errorMessage(error)}` }),
    );
  }

  if (restore === undefined) return null;
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && close(restore)}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          className="spotlight park-thought"
          aria-describedby={undefined}
          data-testid="park-thought"
          // The focus goes back where it was, not to the body.
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Not on to the board's own Esc, which would put a tool down or collapse the tile in front.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          // Its keys are its own: none reach the board's single keys behind it.
          onKeyDown={(event) => event.stopPropagation()}
        >
          <RadixDialog.Title className="visually-hidden">Park a thought</RadixDialog.Title>
          <form
            className="spotlight-field"
            onSubmit={(event) => {
              event.preventDefault();
              park();
            }}
          >
            <MessageCircleDashed aria-hidden />
            <input
              className="spotlight-input"
              aria-label="Park a thought"
              placeholder="Park a thought…"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              ref={input}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Kbd>↵</Kbd>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
