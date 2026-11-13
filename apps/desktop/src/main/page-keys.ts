/**
 * The chords a web page kept. A web tab passes a page every key it has no action for, such as Ctrl+D off
 * macOS; the menu bar's accelerator for the same chord fires as well, and would run the board's Duplicate on top of
 * what the page did. The web tab notes each such press for its window here, and the menu bar drops a key item fired by
 * that chord in that window soon after.
 */

/** A key press as Electron's `before-input-event` gives it. */
export interface PageInput {
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

/** How long after a page kept a press its accelerator is still taken to be that press. */
const KEPT_FOR_MS = 1000;

// A code's key as an accelerator writes it, where it is not the code's last letter or digit.
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Escape',
  Space: 'Space',
  Tab: 'Tab',
};

const keyOfCode = (code: string): string | undefined => CODE_KEYS[code] ?? /^(?:Key|Digit)(.)$/.exec(code)?.[1];

/** Whether `input` is the chord `accelerator` (such as `CommandOrControl+Shift+D`) on this platform. */
export function isAccelerator(accelerator: string, input: PageInput, mac: boolean): boolean {
  const parts = accelerator.split('+');
  // `CommandOrControl++` ends in an empty part for the plus key.
  const key = parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const modifiers = new Set(parts.slice(0, parts.at(-1) === '' ? -2 : -1));
  const either = modifiers.has('CommandOrControl') || modifiers.has('CmdOrCtrl');
  const meta = modifiers.has('Command') || modifiers.has('Cmd') || modifiers.has('Super') || modifiers.has('Meta') || (either && mac);
  const control = modifiers.has('Control') || modifiers.has('Ctrl') || (either && !mac);
  const alt = modifiers.has('Alt') || modifiers.has('Option');
  const shift = modifiers.has('Shift');
  if (input.meta !== meta || input.control !== control || input.alt !== alt || input.shift !== shift) return false;
  const want = key.toUpperCase();
  return input.key.toUpperCase() === want || keyOfCode(input.code)?.toUpperCase() === want;
}

/** The presses each window's web tabs kept, by the window's web contents. */
export function pageKeys(mac: boolean, now: () => number = Date.now) {
  const kept = new Map<number, { input: PageInput; at: number }>();
  return {
    /** A web tab in window `owner` passed `input` to its page: noted only when it is a chord (⌘ or Ctrl held). */
    kept(owner: number, input: PageInput): void {
      if (input.meta || input.control) kept.set(owner, { input, at: now() });
    },
    /** Whether the menu bar's `accelerator` just fired for a press a page in window `owner` kept; the note is used up. */
    took(owner: number, accelerator: string | undefined): boolean {
      const last = kept.get(owner);
      if (last === undefined || accelerator === undefined) return false;
      if (now() - last.at > KEPT_FOR_MS) {
        kept.delete(owner);
        return false;
      }
      if (!isAccelerator(accelerator, last.input, mac)) return false;
      kept.delete(owner);
      return true;
    },
  };
}

export type PageKeys = ReturnType<typeof pageKeys>;
