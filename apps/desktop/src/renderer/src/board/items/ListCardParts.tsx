// What a memory and a queue share: the glyph on a round face with its count, the scope chip, the add box, the folded
// icon and the peek's keys. Props-only, so the gallery draws them as the board does.
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

/**
 * The glyph on its round face, with the count on it: what tells a memory or a queue apart, open or folded, at any zoom.
 * `tab` peeks out above a folded face (a queue's NEXT).
 */
export function ListCardFace({ glyph, count, big = false, pulse = false, tab }: { glyph: ReactNode; count: number; big?: boolean; pulse?: boolean; tab?: ReactNode }) {
  return (
    <span className={big ? 'listcard-face listcard-face-big' : 'listcard-face'} aria-hidden="true">
      {tab}
      {glyph}
      {count > 0 && <span className="listcard-count">{count}</span>}
      {pulse && <span className="listcard-pulse">+1</span>}
    </span>
  );
}

/** Who may use it, as a chip: a zone's carries the zone's colour dot. */
export function ScopeChip({ scope, zoneColor, testId }: { scope: string; zoneColor?: string; testId?: string }) {
  return (
    <span className="listcard-scope" data-testid={testId} style={zoneColor === undefined ? undefined : ({ '--listcard-zone': zoneColor } as CSSProperties)}>
      {zoneColor !== undefined && <i className="listcard-zone-dot" aria-hidden="true" />}
      {scope}
    </span>
  );
}

interface ListCardAddBoxProps {
  /** What was typed, trimmed and not empty: each line of a paste of several lines, when `onLines` takes them. */
  onAdd(text: string): void;
  /** A paste of several lines, taken whole, for a queue's one job a line. */
  onLines?(text: string): void;
  placeholder: string;
  label: string;
  maxLength: number;
  testId: string;
  autoFocus?: boolean;
  /** Before the box's input in place of its "+": a queue's job or note switch. */
  lead?: ReactNode;
}

/** The box at a card's foot, and the peek's: ↵ adds what is typed, esc clears it. */
export function ListCardAddBox({ onAdd, onLines, placeholder, label, maxLength, testId, autoFocus = false, lead }: ListCardAddBoxProps) {
  const [text, setText] = useState('');
  const add = () => {
    if (text.trim() === '') return;
    onAdd(text.trim());
    setText('');
  };
  // A label, so a click anywhere on it types; with a switch before the input, a box, or the click would press the switch.
  const Box = lead === undefined ? 'label' : 'div';
  return (
    // A double-click selects a word as it types, not the card's open.
    <Box className="listcard-add nodrag" onDoubleClick={(event) => event.stopPropagation()}>
      {lead ?? (
        <span className="listcard-add-plus" aria-hidden="true">
          +
        </span>
      )}
      <input
        className="listcard-add-input"
        data-testid={testId}
        value={text}
        maxLength={maxLength}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text');
          if (onLines === undefined || !pasted.trim().includes('\n')) return;
          event.preventDefault();
          onLines(pasted);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            add();
          } else if (event.key === 'Escape') {
            setText('');
            event.currentTarget.blur();
          }
        }}
      />
      <kbd className="listcard-add-key" aria-hidden="true">
        ↵
      </kbd>
    </Box>
  );
}

interface ListCardIconViewProps {
  glyph: ReactNode;
  title: string;
  scope: string;
  zoneColor?: string;
  /** How much bigger than the board's zoom its face draws, zoomed far out: it stays big enough to read. */
  lift?: number;
  count: number;
  /** A line under the name in place of the scope chip: what an agent just did, or what an empty one asks for. */
  sub?: string;
  /** What an empty one's line says. */
  empty: string;
  pulse?: boolean;
  tab?: ReactNode;
  testId: string;
  onOpen(): void;
  children?: ReactNode;
}

/** Folded to its icon: the glyph on a big round face with its count, its name under it. A click opens the peek. */
export function ListCardIconView({ glyph, title, scope, zoneColor, lift = 1, count, sub, empty, pulse, tab, testId, onOpen, children }: ListCardIconViewProps) {
  return (
    <div
      className="listcard listcard-icon"
      data-testid={testId}
      data-empty={count === 0 || undefined}
      data-lifted={lift > 1 || undefined}
      data-tab={tab !== undefined || undefined}
      style={lift > 1 ? ({ '--listcard-lift': lift } as CSSProperties) : undefined}
    >
      {children}
      <button type="button" className="listcard-icon-face nodrag" aria-label={`${title}: open its peek`} onClick={onOpen}>
        <ListCardFace glyph={glyph} count={count} big pulse={pulse} tab={tab} />
      </button>
      <b className="listcard-icon-name">{title}</b>
      {sub !== undefined || count === 0 ? <span className="listcard-icon-sub">{sub ?? empty}</span> : <ScopeChip scope={scope} zoneColor={zoneColor} />}
    </div>
  );
}

interface PeekKeys<Row> {
  /** The peek's list, whose rows' main buttons carry `data-row` with their row's id. */
  list: RefObject<HTMLUListElement | null>;
  search: RefObject<HTMLInputElement | null>;
  /** The row with that id, of those shown. */
  row(id: string | undefined): Row | undefined;
  onEdit(row: Row): void;
  onRemove(row: Row): void;
  /** Any other key on a row, before E and ⌫: true when it was taken. */
  other?(event: KeyboardEvent<HTMLElement>, row: Row): boolean;
}

/**
 * A peek's keys: / searches, ↑ and ↓ move between rows (↓ from the search, ↑ back to it), E or ↵ edits the row, ⌫
 * removes it and moves to its neighbour. Typing in a field other than the search is left alone.
 */
export function peekKeys<Row>({ list, search, row: rowOf, onEdit, onRemove, other }: PeekKeys<Row>) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target !== search.current)) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.listcard-peek-entry') ?? [])];
    // From a row's own buttons, ↑ and ↓ move on from that row.
    const own = target.closest('.listcard-peek-row')?.querySelector<HTMLButtonElement>('.listcard-peek-entry');
    const at = own === null || own === undefined ? -1 : buttons.indexOf(own);
    const row = rowOf(own?.dataset.row);
    const step = (by: number) => {
      event.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, at + by))]?.focus();
    };
    if (event.altKey && row !== undefined && other?.(event, row) === true) return;
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp' && at > 0) step(-1);
    else if (event.key === 'ArrowUp' && at === 0) {
      event.preventDefault();
      search.current?.focus();
    } else if (target === search.current) return;
    else if (event.key === '/') {
      event.preventDefault();
      search.current?.focus();
    } else if (row === undefined || own !== target) return;
    else if (event.key === 'e' || event.key === 'E') {
      event.preventDefault();
      onEdit(row);
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      buttons[at + 1 < buttons.length ? at + 1 : at - 1]?.focus();
      onRemove(row);
    }
  };
}
