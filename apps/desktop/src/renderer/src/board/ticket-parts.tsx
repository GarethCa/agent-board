// What a ticket's tile draws the same way at rest and opened: its Card | Terminal | Board switch and the ⋯ rows that
// do the same, the view it shows, and a helper as a card.
import { useContext, type MouseEvent, type ReactNode } from 'react';
import { Hammer, LayoutDashboard, PanelTop, PenLine, Search, SquareTerminal } from 'lucide-react';
import type { ModelEntry } from './menu-model';
import { TicketViewsContext, TileActionsContext } from './tile';
import { stopPropagation } from './tile-parts';
import type { HelperIcon, HelperKind } from './ticket-tile';
import { ticketViewOf, type TicketView } from './ticket-view';
import { useViewSettings } from './view-settings';

export const HELPER_ICONS: Record<HelperKind, ReactNode> = {
  design: <PenLine aria-hidden />,
  build: <Hammer aria-hidden />,
  review: <Search aria-hidden />,
};

/**
 * The ticket tile's view: the one the board shows it in (switched by hand, or the card for an over ticket resting),
 * else the one Settings › Board says ticket tiles open as.
 */
export function useTicketView(nodeId: string): TicketView {
  const views = useContext(TicketViewsContext);
  return ticketViewOf(views, nodeId, useViewSettings().ticketTilesOpenAs);
}

/**
 * Switches the ticket tile to a view by hand, and it keeps it. The terminal shows at once; so does the board: switched
 * to it, the user is taken into the ticket's board, and comes back out to its card. The switch ignores its pressed icon,
 * so only Open as board goes in again from a tile already in the board view.
 */
export function useSwitchTicketView(nodeId: string, chatSessionId: string): (view: TicketView) => void {
  const { setTicketView, openTicketBoard } = useContext(TileActionsContext);
  return (view) => {
    setTicketView(nodeId, view);
    if (view === 'board') openTicketBoard(chatSessionId);
  };
}

const VIEWS: readonly { view: TicketView; icon: ReactNode; label: string }[] = [
  { view: 'card', icon: <PanelTop aria-hidden />, label: 'Show as a card' },
  { view: 'terminal', icon: <SquareTerminal aria-hidden />, label: 'Show as a terminal' },
  { view: 'board', icon: <LayoutDashboard aria-hidden />, label: 'Show as a board' },
];

/** The tile's Card | Terminal | Board switch: three icons, the view it shows pressed. */
export function TicketViewSwitch({ view, onSwitch }: { view: TicketView; onSwitch(view: TicketView): void }) {
  return (
    <span className="ticket-view-switch nodrag" role="group" aria-label="View" data-testid="ticket-view-switch">
      {VIEWS.map((each) => (
        <button
          key={each.view}
          type="button"
          aria-pressed={each.view === view}
          aria-label={each.label}
          title={each.label}
          data-view={each.view}
          onClick={() => each.view !== view && onSwitch(each.view)}
          onDoubleClick={stopPropagation}
        >
          {each.icon}
        </button>
      ))}
    </span>
  );
}

/** The ⋯ menu's rows that switch the tile to each other view, first in the menu (`ticketMenuEntries`). */
export function viewRows(view: TicketView, onSwitch: (view: TicketView) => void): ModelEntry[] {
  return VIEWS.filter((each) => each.view !== view).map((each) => ({ id: `ticket-view-${each.view}`, label: each.label, icon: each.icon, onSelect: () => onSwitch(each.view) }));
}

/**
 * A helper as a card, in the terminal view's strip or the opened card's column: its icon, name and the line under it, and
 * in the column its state in a word. A click shows it in the tile in place of the chat; ⌥-click opens its own window.
 */
export function HelperCard({ helper, column, open, onShow, onOpenWindow }: { helper: HelperIcon; column: boolean; open: boolean; onShow(): void; onOpenWindow(): void }) {
  const click = (event: MouseEvent) => (event.altKey ? onOpenWindow() : onShow());
  return (
    <button
      type="button"
      className="ticket-helper-card nodrag"
      data-testid="ticket-helper-card"
      data-kind={helper.kind}
      data-state={helper.state}
      data-open={open || undefined}
      data-ask={helper.state === 'you' || undefined}
      title={`${helper.title}. Click to show it here; ⌥-click to open its window`}
      onClick={click}
      onDoubleClick={stopPropagation}
    >
      <span className="ticket-helper-card-icon" data-state={helper.state}>
        {HELPER_ICONS[helper.kind]}
      </span>
      <b className="ticket-helper-card-name">{helper.name}</b>
      {column && (
        <span className="ticket-helper-card-word" data-state={helper.state}>
          {helper.word}
        </span>
      )}
      <span className="ticket-helper-card-line">{column && open ? 'Showing on the left' : helper.line}</span>
    </button>
  );
}
