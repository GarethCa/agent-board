import { PanelLeft } from 'lucide-react';
import { keyText } from '../keys/registry';
import { IconButton } from '../ui';

/**
 * The Simplified header's button that opens the shelves or collapses them to their rail (⌘I does too); the focus goes back
 * to it when they are pulled shut. An expanded tile's header, which has a Collapse button of its own, names it `hideLabel`.
 */
export function DetailsToggle({ open, onOpen, hideLabel = 'Collapse the shelves' }: { open: boolean; onOpen(open: boolean): void; hideLabel?: string }) {
  return (
    <IconButton
      icon={<PanelLeft />}
      size="sm"
      aria-label={open ? hideLabel : 'Show the shelves'}
      aria-pressed={open}
      data-details-toggle
      tooltip={`${open ? 'Collapse the shelves to a rail' : 'Show the shelves'}  ${keyText('window.details')}`}
      onClick={() => onOpen(!open)}
    />
  );
}
