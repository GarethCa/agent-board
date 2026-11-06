import { PanelLeft } from 'lucide-react';
import { keyText } from '../keys/registry';
import { IconButton } from '../ui';

/** The Simplified header's button that opens the shelves or collapses them to their rail (⌘I does too); the focus goes back to it when they are pulled shut. */
export function DetailsToggle({ open, onOpen }: { open: boolean; onOpen(open: boolean): void }) {
  return (
    <IconButton
      icon={<PanelLeft />}
      size="sm"
      aria-label={open ? 'Collapse the shelves' : 'Show the shelves'}
      aria-pressed={open}
      data-details-toggle
      tooltip={`${open ? 'Collapse the shelves to a rail' : 'Show the shelves'}  ${keyText('window.details')}`}
      onClick={() => onOpen(!open)}
    />
  );
}
