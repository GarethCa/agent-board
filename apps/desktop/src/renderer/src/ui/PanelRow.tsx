import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

interface PanelRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** The icon or mark at its start. */
  mark?: ReactNode;
  name: ReactNode;
  /** A line of detail under the name. */
  meta?: ReactNode;
  /** A pill, a fact or an action at its end. */
  end?: ReactNode;
  /** Sets `end` in the meta's quiet type, as a count is. */
  quietEnd?: boolean;
  /** A `button` when the row does something, an `li` in a list, else a `div`. */
  as?: 'button' | 'li' | 'div';
  ref?: Ref<HTMLElement>;
}

/**
 * A row in a side panel's section (`Section`): a mark, a name with a line of detail under it, and something at its end.
 * As a button, it highlights under the pointer.
 */
export function PanelRow({ mark, name, meta, end, quietEnd = false, as = 'div', className, ref, ...rest }: PanelRowProps) {
  const body = (
    <>
      {mark}
      <span className="ui-row-name">
        {name}
        {meta !== undefined && <span className="ui-row-meta">{meta}</span>}
      </span>
      {end !== undefined && <span className={cx('ui-row-end', quietEnd && 'ui-row-meta')}>{end}</span>}
    </>
  );
  const props = { className: cx('ui-row', className), ...rest };
  if (as === 'button') {
    return (
      <button type="button" ref={ref as Ref<HTMLButtonElement>} {...props}>
        {body}
      </button>
    );
  }
  if (as === 'li') {
    return (
      <li ref={ref as Ref<HTMLLIElement>} {...props}>
        {body}
      </li>
    );
  }
  return (
    <div ref={ref as Ref<HTMLDivElement>} {...props}>
      {body}
    </div>
  );
}
