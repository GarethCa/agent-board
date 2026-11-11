import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { FindResult, FindStep } from '../../../preload/api';
import { IconButton, Input } from '../ui';
import type { Finder } from './dom-find';

interface FindBarProps {
  finder: Finder;
  /** Changes whenever ⌘F is pressed again with the bar open: the field takes the keyboard and selects its text. */
  focusSignal: number;
  onClose(): void;
}

/** What the bar says of a search: nothing before one, the match shown of all, or that there are none. */
export function findCount(text: string, result: FindResult): string {
  if (text === '') return '';
  return result.total === 0 ? 'No matches' : `${result.active} of ${result.total}`;
}

/** The find bar of a document or web page: a field, how many matches, previous and next (⇧↵, ↵), close (esc). */
export function FindBar({ finder, focusSignal, onClose }: FindBarProps) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const latest = useRef(0);
  const [result, setResult] = useState<FindResult>({ active: 0, total: 0 });
  const search = (typed: string, step: FindStep) => {
    // Only the last search shown: an earlier one may answer after it, and a page answers a superseded one with none.
    const mine = ++latest.current;
    const shown = (found: FindResult) => {
      if (mine === latest.current) setResult(found);
    };
    finder.search(typed, step).then(shown, () => shown({ active: 0, total: 0 }));
  };
  const close = () => {
    onClose();
    finder.focus?.();
  };
  useEffect(() => {
    finder.takeKeyboard?.();
    field.current?.focus();
    field.current?.select();
  }, [focusSignal]);
  useEffect(() => () => finder.clear(), [finder]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (text !== '') search(text, event.shiftKey ? 'previous' : 'next');
    }
  };
  const step = (which: FindStep) => text !== '' && search(text, which);
  return (
    <div className="find-bar" data-testid="find-bar" role="search">
      <Input
        size="sm"
        className="find-field"
        data-testid="find-field"
        aria-label="Find"
        placeholder="Find"
        spellCheck={false}
        ref={field}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          search(event.target.value, 'first');
        }}
        onKeyDown={onKeyDown}
      />
      <span className="find-count" data-testid="find-count" aria-live="polite">
        {findCount(text, result)}
      </span>
      <IconButton icon={<ChevronUp />} aria-label="Previous match" size="xs" disabled={result.total === 0} onClick={() => step('previous')} />
      <IconButton icon={<ChevronDown />} aria-label="Next match" size="xs" disabled={result.total === 0} onClick={() => step('next')} />
      <IconButton icon={<X />} aria-label="Close find" size="xs" onClick={close} />
    </div>
  );
}
