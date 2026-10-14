import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cx } from './cx';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Primary: the dialog's or row's main action. Secondary: the rest. Ghost: quiet, in dense rows. Danger: destroys. */
  variant?: ButtonVariant;
  /** `xs` fits a dense row such as a tile's head; `lg` is a full-page step's main actions, as onboarding's. */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** An icon before the label, from lucide-react. */
  icon?: ReactNode;
  /** An icon after the label, such as a menu's chevron. */
  trailingIcon?: ReactNode;
  /** Shows a spinner in place of the icon and takes no clicks, keeping its label so the layout holds still. */
  loading?: boolean;
  /** A hint shown in a Tooltip on hover and focus, such as what it does and its key. */
  tooltip?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** The app's button. Its look comes from ui.css: one focus ring, and the same hover, press and disabled states. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailingIcon,
  loading = false,
  tooltip,
  disabled,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const button = (
    <button
      type={type}
      className={cx('ui-button', className)}
      data-variant={variant}
      data-size={size}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {trailingIcon}
    </button>
  );
  return tooltip === undefined ? button : <Tooltip content={tooltip}>{button}</Tooltip>;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** What it does, for screen readers and the tooltip. Required: the button has no text of its own. */
  'aria-label': string;
  icon: ReactNode;
  variant?: ButtonVariant;
  /** `xs` fits a dense row such as a tile's head. */
  size?: 'xs' | 'sm' | 'md';
  loading?: boolean;
  /**
   * A hint shown in a Tooltip on hover and focus: the app's chrome uses it. Without one the button shows its `title`,
   * or else its label, as the native tooltip: what a tile's buttons use, cheap enough for hundreds on a busy board.
   */
  tooltip?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** A button that shows only an icon. */
export function IconButton({
  icon,
  variant = 'ghost',
  size = 'sm',
  loading = false,
  tooltip,
  title,
  disabled,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cx('ui-button', 'ui-icon-button', className)}
      data-variant={variant}
      data-size={size}
      aria-busy={loading || undefined}
      title={tooltip === undefined ? (title ?? rest['aria-label']) : title}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
    </button>
  );
  return tooltip === undefined ? button : <Tooltip content={tooltip}>{button}</Tooltip>;
}

/** A turning spinner, for a control that is working. */
export function Spinner() {
  return <LoaderCircle className="ui-spinner" />;
}

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** An icon before the label, from lucide-react. */
  icon?: ReactNode;
  /** `accent` for an issue key; otherwise the chip's colours come from its --chip and --chip-ink (a PR's state). */
  tone?: 'accent';
  /** Code-like text: an issue key, a PR number. */
  mono?: boolean;
  'data-testid'?: string;
}

/**
 * A small label that opens something: an issue key, a pull request, a schedule, a zone's tracker. A caller may set
 * --chip, --chip-ink and --chip-edge on it to colour it by its data (a PR's state, a zone's colour).
 */
export function Chip({ icon, tone, mono = false, className, type = 'button', children, ...rest }: ChipProps) {
  return (
    <button type={type} className={cx('ui-chip', className)} data-tone={tone} data-mono={mono || undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
}
