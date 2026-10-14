import { useId, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cx } from './cx';

interface SectionProps {
  /** Its small caps heading. */
  label: string;
  /** An icon before the heading, from lucide-react. */
  icon?: ReactNode;
  /** A short fact at the heading's end: "2 active · 1 done". */
  meta?: ReactNode;
  /** Whether it starts open; the user opens and closes it from then on. */
  defaultOpen?: boolean;
  /** Draws it open or closed from outside, e.g. from an icon rail. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
  'data-testid'?: string;
}

/**
 * A titled group in a side panel, such as the board menu's Zones or a session window's Subagents: a heading row that
 * opens and closes it, its rows under it. The board menu and the session window's details use the same one, so the two
 * read as one system.
 */
export function Section({ label, icon, meta, defaultOpen = true, open, onOpenChange, children, className, ref, ...rest }: SectionProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = open ?? ownOpen;
  const body = useId();
  const toggle = () => {
    setOwnOpen(!isOpen);
    onOpenChange?.(!isOpen);
  };
  return (
    <section ref={ref} className={cx('ui-section', className)} aria-label={label} data-open={isOpen} data-testid={rest['data-testid']}>
      <button type="button" className="ui-section-head" aria-expanded={isOpen} aria-controls={body} onClick={toggle}>
        {isOpen ? <ChevronDown className="ui-section-chevron" aria-hidden /> : <ChevronRight className="ui-section-chevron" aria-hidden />}
        {icon}
        <span className="ui-section-label">{label}</span>
        {meta !== undefined && <span className="ui-section-meta">{meta}</span>}
      </button>
      {isOpen && (
        <div id={body} className="ui-section-body">
          {children}
        </div>
      )}
    </section>
  );
}
