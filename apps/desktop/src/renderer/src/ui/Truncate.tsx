import { cx } from './cx';

/**
 * One line of text that ends in an ellipsis when its box is too narrow, and shows whole on hover. It shrinks in a flex
 * row or a grid cell; `title` is the text unless a fuller one is given, or `null` when the control round it already
 * shows it whole in its own tooltip.
 */
export function Truncate({ text, title = text, className, 'data-testid': testId }: { text: string; title?: string | null; className?: string; 'data-testid'?: string }) {
  return (
    <span className={cx('ui-truncate', className)} title={title ?? undefined} data-testid={testId}>
      {text}
    </span>
  );
}
