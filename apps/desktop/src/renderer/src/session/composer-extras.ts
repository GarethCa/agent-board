import { Cpu, Paperclip, Shrink } from 'lucide-react';
import { createElement } from 'react';
import type { MenuEntry } from '../ui';

interface ComposerExtras {
  /** Opens the picker for images to attach. */
  onAttach(): void;
  /** Puts a harness command in the field. The user sends it, with Enter, as they would type it. */
  onCommand(command: string): void;
  /** What the field holds now. */
  draft: string;
}

/** `command` as the field's whole text, or undefined over a draft, which a command must not swallow or follow. */
function commandText(draft: string, command: string): string | undefined {
  return draft.trim() === '' ? command : undefined;
}

/**
 * The rows of the "+" menu under the Simplified design: attaching an image, and the two harness commands worth
 * naming. The commands are typed for the user, not sent: they reach the agent as any message does, on Enter.
 */
export function composerExtras({ onAttach, onCommand, draft }: ComposerExtras): MenuEntry[] {
  const command = (label: string, text: string, icon: typeof Cpu) => {
    const typed = commandText(draft, text);
    return { label, icon: createElement(icon, { 'aria-hidden': true }), disabled: typed === undefined, hint: typed === undefined ? 'Clear the message first' : undefined, onSelect: () => onCommand(text) };
  };
  return [
    { label: 'Attach an image…', icon: createElement(Paperclip, { 'aria-hidden': true }), onSelect: onAttach },
    'separator',
    command('Summarise the conversation so far', '/compact', Shrink),
    command('Change model…', '/model ', Cpu),
  ];
}
