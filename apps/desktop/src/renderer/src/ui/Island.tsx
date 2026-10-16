import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';
import { Kbd } from './Label';
import { Tooltip } from './Tooltip';

type IslandProps = HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string; ref?: Ref<HTMLDivElement> };

/**
 * A floating island over the board (chrome C): a white pill of controls with a soft shadow. Where it sits is up to
 * its caller.
 */
export function Island({ className, ...rest }: IslandProps) {
  return <div className={cx('ui-island', className)} {...rest} />;
}

/** A thin rule between an island's groups. */
export function IslandSeparator() {
  return <span className="ui-island-separator" aria-hidden />;
}

interface ToolButtonProps {
  /** What it does, for screen readers and the tooltip's first words. */
  label: string;
  icon: ReactNode;
  /** The key that does the same, shown in its corner and its tooltip. */
  shortcut?: string;
  /** A tool that stays armed, such as Text: whether it is now. */
  pressed?: boolean;
  /** More of the tooltip, after the label: how to use it. */
  hint?: string;
  size?: 'sm' | 'md';
  className?: string;
  onClick?(): void;
  ref?: Ref<HTMLButtonElement>;
  /** Holds it in its hover, active or focus look, for the component gallery. */
  'data-preview'?: string;
}

/** A square tool on an island: an icon, its key in the corner, and a tooltip with both. */
export function ToolButton({ label, icon, shortcut, pressed, hint, size = 'md', className, onClick, ref, ...rest }: ToolButtonProps) {
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          {hint ?? label}
          {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
        </>
      }
    >
      <button
        ref={ref}
        type="button"
        className={cx('ui-tool', className)}
        data-size={size}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut}
        onClick={onClick}
        {...rest}
      >
        {icon}
        {shortcut !== undefined && (
          <span className="ui-tool-key" aria-hidden>
            {shortcut}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
