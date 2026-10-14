import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** Holds it in a pointer or focus state, for the component gallery. */
  preview?: 'hover' | 'focus';
}

interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  'aria-label': string;
  className?: string;
}

/**
 * A few toggle buttons side by side on a sunken track, one of them pressed: how something is shown, or which kind it
 * is, such as an edge's payload or a session window's terminal or chat view.
 */
export function Segmented<T extends string>({ options, value, onChange, className, 'aria-label': label }: SegmentedProps<T>) {
  return (
    <div className={cx('ui-segmented', className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          data-preview={option.preview}
          onClick={() => option.id !== value && onChange(option.id)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
