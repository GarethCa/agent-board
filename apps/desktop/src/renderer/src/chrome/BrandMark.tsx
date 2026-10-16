import markUrl from '../../../../../../brand/svg/mark.svg?no-inline';
import markDarkUrl from '../../../../../../brand/svg/mark-dark.svg?no-inline';
import markPlainUrl from '../../../../../../brand/svg/mark-plain.svg?no-inline';
import { cx } from '../ui/cx';

/**
 * The app's mark (brand/BRAND.md): on its square, desk blue or in a dark theme the dark colourway (CSS shows the
 * one for `data-scheme`); or `plain`, without the square, for the board's desk. Decorative: the name beside it says what
 * it is.
 */
export function BrandMark({ variant = 'square', className }: { variant?: 'square' | 'plain'; className?: string }) {
  if (variant === 'plain') return <img className={cx('brand-mark', className)} src={markPlainUrl} alt="" draggable={false} />;
  return (
    <span className={cx('brand-mark', className)} data-testid="brand-mark">
      <img className="brand-mark-light" src={markUrl} alt="" draggable={false} />
      <img className="brand-mark-dark" src={markDarkUrl} alt="" draggable={false} />
    </span>
  );
}
