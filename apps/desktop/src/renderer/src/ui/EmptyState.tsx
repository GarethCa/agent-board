import type { ReactNode } from 'react';
import { cx } from './cx';

interface EmptyStateProps {
  /** What isn't here yet: "No agents in web yet". */
  title: ReactNode;
  /** How to start it. */
  children?: ReactNode;
  /** A picture over the title, such as a character. */
  art?: ReactNode;
  /** The action that fills it, such as a primary small Button. */
  action?: ReactNode;
  /** A dashed frame, for an empty area; none for an empty list inside a card. */
  framed?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** What an empty place shows: what would be here, and how to start it. */
export function EmptyState({ title, children, art, action, framed = true, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', className)} data-framed={framed} data-testid={rest['data-testid']}>
      {art}
      <p className="ui-empty-title">{title}</p>
      {children !== undefined && <p className="ui-empty-body">{children}</p>}
      {action}
    </div>
  );
}
