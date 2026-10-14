// The platform's command key: ⌘ on macOS, Ctrl elsewhere, for the app's own shortcuts and how they are written.

const mac = navigator.platform.startsWith('Mac');

/** Whether the platform's command key is held in `event`. */
export function commandKey(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** A shortcut with the command key as the platform writes it: `⌘K`, or `Ctrl+K`. */
export function withCommand(key: string): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The key that turns the wheel into a zoom on the board, as React Flow names it: the command key. */
export const ZOOM_KEY = mac ? 'Meta' : 'Control';
