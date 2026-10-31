import { useCallback, useEffect, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { SESSION_SURFACES } from '../board/board-shortcuts';
import { Kbd } from '../ui';
import { inOverlay } from '.';
import { CONTEXT_LABELS, cheatSheet, type SheetContext } from './cheat-sheet';
import { useExtendedShortcuts } from './extended-shortcuts';
import { keyText, pressed } from './registry';

/**
 * The keyboard cheat sheet: every key the app answers to, from the registry, the sections for where it opened first.
 * Typing filters it; Esc closes it, and so does ? while the filter is empty, or ⌘/ again.
 */
function CheatSheet({ context, onClose }: { context: SheetContext; onClose(): void }) {
  const extended = useExtendedShortcuts();
  const [filter, setFilter] = useState('');
  const sections = cheatSheet(context, { extended, filter });
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-scrim" />
        <RadixDialog.Content
          className="ui-card cheat-sheet"
          aria-describedby={undefined}
          data-testid="cheat-sheet"
          // Not on to the board's own Esc, which would put a tool down or collapse the tile in front.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Its keys are its own: none reach the board's single keys behind it.
            event.stopPropagation();
            if (filter === '' && pressed('move.cheatSheet', event)) {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <div className="cheat-sheet-head">
            <RadixDialog.Title className="cheat-sheet-title">Keyboard</RadixDialog.Title>
            <span className="cheat-sheet-here" data-testid="cheat-sheet-here">
              here: {CONTEXT_LABELS[context]}
            </span>
            <input
              className="ui-input cheat-sheet-filter"
              data-size="sm"
              type="search"
              aria-label="Filter the keys"
              placeholder="Filter…"
              spellCheck={false}
              autoComplete="off"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="cheat-sheet-columns">
            {sections.map((section) => (
              <section key={section.id} className="cheat-sheet-section" aria-label={section.title} data-here={section.here || undefined}>
                <h3 className="ui-section-label">{section.title}</h3>
                {section.rows.map((row) => (
                  <div key={row.id} className="cheat-sheet-row" data-testid="cheat-sheet-row" data-key={row.id}>
                    <span>{row.label}</span>
                    <span className="cheat-sheet-keys">
                      {row.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
            {sections.length === 0 && <p className="cheat-sheet-empty">No key matches</p>}
          </div>
          <div className="cheat-sheet-foot">
            <span>
              {extended && (
                <>
                  <Kbd>{keyText('move.cheatSheet')}</Kbd> or{' '}
                </>
              )}
              <Kbd>{keyText('dialog.close')}</Kbd> close
            </span>
            <span>Extended keyboard shortcuts are {extended ? 'on' : 'off'}: Settings › General › Keyboard</span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * The cheat sheet's keys, ? on the board (the board's own keys open it) and ⌘/ anywhere, the terminal included; and
 * where it is open, for where it opened. `contextOf` says where that is when it opens.
 */
export function useCheatSheet(contextOf: () => SheetContext) {
  const [open, setOpen] = useState<SheetContext>();
  const contextRef = useRef(contextOf);
  contextRef.current = contextOf;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.cheatSheetAnywhere', event)) return;
      // Another dialog or menu keeps its keys; a session window, a dialog too, is where it opens from.
      if (openRef.current === undefined && inOverlay() && document.activeElement?.closest(SESSION_SURFACES) == null) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(openRef.current === undefined ? contextRef.current() : undefined);
    };
    // Before the terminal's keys, wherever the focus is.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const openSheet = useCallback(() => setOpen(contextRef.current()), []);
  return {
    open: openSheet,
    sheet: open === undefined ? null : <CheatSheet context={open} onClose={() => setOpen(undefined)} />,
  };
}
