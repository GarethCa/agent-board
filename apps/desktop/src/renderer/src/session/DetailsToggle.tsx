import { PanelRight } from 'lucide-react';
import { keyText } from '../keys/registry';
import { IconButton } from '../ui';

/** The header's button that shows or hides the inspector (⌘I does too); the focus goes back to it when the inspector is pulled shut. */
export function DetailsToggle({ open, onOpen }: { open: boolean; onOpen(open: boolean): void }) {
  return (
    <IconButton
      icon={<PanelRight />}
      size="sm"
      aria-label={open ? 'Hide details' : 'Show details'}
      aria-pressed={open}
      data-details-toggle
      tooltip={`${open ? 'Hide' : 'Show'} its details  ${keyText('window.details')}`}
      onClick={() => onOpen(!open)}
    />
  );
}
