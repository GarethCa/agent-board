// What the cheat sheet lists: the registry's active keys by section, the sections for where it opened first.
import { chordsOf, chordText, isActive, KEYS, type KeyBinding, type KeyId, type SectionId } from './registry';

const mac = navigator.platform.startsWith('Mac');

/** Where the sheet opened: the board, the board with one agent or shell tile selected, or a session window. */
export type SheetContext = 'board' | 'tile' | 'window';

const TITLES: Record<SectionId, string> = {
  tile: 'This tile',
  move: 'Move around',
  make: 'Make',
  edit: 'Edit',
  window: 'In a session window',
  dialog: 'Menus and dialogs',
};

/** The sections for each place, its own first: those are the ones "here". */
const ORDER: Record<SheetContext, { here: readonly SectionId[]; rest: readonly SectionId[] }> = {
  board: { here: ['move', 'make', 'edit'], rest: ['tile', 'window', 'dialog'] },
  tile: { here: ['tile'], rest: ['move', 'make', 'edit', 'window', 'dialog'] },
  window: { here: ['window'], rest: ['move', 'make', 'edit', 'tile', 'dialog'] },
};

/** How the sheet names where it opened. */
export const CONTEXT_LABELS: Record<SheetContext, string> = {
  board: 'board',
  tile: 'board · tile selected',
  window: 'session window',
};

export interface SheetRow {
  id: KeyId;
  label: string;
  keys: string[];
}

export interface SheetSection {
  id: SectionId;
  title: string;
  /** One of the sections for where it opened. */
  here: boolean;
  rows: SheetRow[];
}

interface SheetOptions {
  /** The "Extended keyboard shortcuts" setting: off, the `new` keys are left out. */
  extended: boolean;
  /** What was typed in its filter: rows whose label or keys have it. */
  filter?: string;
  isMac?: boolean;
}

/** The cheat sheet opened in `context`: each section with a row it keeps, the ones for `context` first. */
export function cheatSheet(context: SheetContext, { extended, filter = '', isMac = mac }: SheetOptions): SheetSection[] {
  const needle = filter.trim().toLowerCase();
  const rowOf = (entry: KeyBinding): SheetRow => ({
    id: entry.id as KeyId,
    label: entry.label,
    keys: chordsOf(entry, isMac).map((chord) => chordText(chord, isMac)),
  });
  const kept = (row: SheetRow) => needle === '' || row.label.toLowerCase().includes(needle) || row.keys.some((key) => key.toLowerCase().includes(needle));
  const { here, rest } = ORDER[context];
  return [...here, ...rest]
    .map((id) => ({
      id,
      title: TITLES[id],
      here: here.includes(id),
      rows: KEYS.filter((entry) => entry.section === id && isActive(entry, extended))
        .map(rowOf)
        .filter(kept),
    }))
    .filter((section) => section.rows.length > 0);
}
