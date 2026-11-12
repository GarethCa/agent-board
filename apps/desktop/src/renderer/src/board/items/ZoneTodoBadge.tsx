// The count on a zone's tab of the to-do lines still open in its to-do lists: teal, never the Needs-you orange, since
// a to-do holds no agent up. None while nothing is left. A click opens the zone's lists, grouped by whose they are.
import { useState } from 'react';
import { useStore } from '@xyflow/react';
import { SquareCheckBig } from 'lucide-react';
import { Popover } from '../../ui';
import { zoneTodos } from './todo-view';
import { boardItems, ZoneTodoPopover } from './ZoneTodoPopover';

/** Esc in a line being edited cancels the edit, not the popover. */
const keepWhileEditing = (event: KeyboardEvent) => {
  if ((event.target as HTMLElement | null)?.closest?.('.todo-pop .todo-field') != null) event.preventDefault();
};

export function ZoneTodoBadge({ zoneId }: { zoneId: string }) {
  // A number, so the tab draws again only when the count changes.
  const open = useStore((state) => zoneTodos(boardItems(state.nodes), zoneId).open);
  const [shown, setShown] = useState(false);
  // Open, it stays while its last line is ticked: what was ticked can be unticked there.
  if (open === 0 && !shown) return null;
  const words = `${open} to-do${open === 1 ? '' : 's'} left in this zone`;
  return (
    <Popover open={shown} onOpenChange={setShown} aria-label="To-do lists in this zone" align="start" className="todo-popover" content={<ZoneTodoPopover zoneId={zoneId} onShown={() => setShown(false)} />}
      onEscapeKeyDown={keepWhileEditing}
    >
      <button type="button" className="zone-todo-badge nodrag" data-testid="zone-todo-badge" aria-label={words} title={`${words}: list them`}>
        <SquareCheckBig aria-hidden />
        {open}
      </button>
    </Popover>
  );
}
