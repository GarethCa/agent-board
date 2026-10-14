import type { HTMLAttributes, ReactNode } from 'react';
import { ArrowRight, Check, Clock, Hourglass, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { AgentState } from '@agent-board/daemon/protocol';
import { STATE_LABELS } from '../states';
import { cx } from './cx';

type SpanProps = HTMLAttributes<HTMLSpanElement> & { 'data-testid'?: string };

/** A count: how many things want attention. `neutral` when there is nothing to count. */
export function Badge({ tone = 'attention', className, ...rest }: SpanProps & { tone?: 'attention' | 'neutral' }) {
  return <span className={cx('ui-badge', className)} data-tone={tone} {...rest} />;
}

/** A short label: a zone's kind, an issue key (`accent`, `mono`), a PR number (`mono`). */
export function Tag({ tone, mono = false, className, ...rest }: SpanProps & { tone?: 'accent'; mono?: boolean }) {
  return <span className={cx('ui-tag', className)} data-tone={tone} data-mono={mono || undefined} {...rest} />;
}

/** The marks the states that end or stall carry, and handing off, in place of the dot the moving ones have. */
const STATE_ICONS: Partial<Record<AgentState, ReactNode>> = {
  'needs-permission': <ShieldAlert aria-hidden />,
  'rate-limited': <Hourglass aria-hidden />,
  failed: <X aria-hidden />,
  done: <Check aria-hidden />,
  scheduled: <Clock aria-hidden />,
  'stopped-by-restart': <RotateCcw aria-hidden />,
  'handing-off': <ArrowRight aria-hidden />,
};

/** An agent's state as a pill: its colour, a dot or mark, and its name. */
export function StatusPill({ state, label, className, ...rest }: SpanProps & { state: AgentState; label?: ReactNode }) {
  return (
    <span className={cx('ui-pill', className)} data-state={state} {...rest}>
      {STATE_ICONS[state] ?? <span className="ui-pill-dot" aria-hidden />}
      <span className="ui-pill-label">{label ?? STATE_LABELS[state]}</span>
    </span>
  );
}

/** A pill in the flow colours, for a flow edge or a hand-off rather than an agent's state: "new", "receiving…". */
export function FlowPill({ className, children, ...rest }: SpanProps) {
  return (
    <span className={cx('ui-pill', className)} data-flow {...rest}>
      <span className="ui-pill-dot" aria-hidden />
      <span className="ui-pill-label">{children}</span>
    </span>
  );
}

/** A key, in a shortcut hint: `<Kbd>⌘</Kbd><Kbd>K</Kbd>`. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx('ui-kbd', className)} {...rest} />;
}

/** A shortcut hint: its keys, then what it does. */
export function Shortcut({ keys, children }: { keys: string[]; children?: ReactNode }) {
  return (
    <span className="ui-kbd-row">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {children}
    </span>
  );
}

/** A small caps label over a group. */
export function SectionLabel({ children, as: Heading = 'h3' }: { children: ReactNode; as?: 'h2' | 'h3' | 'h4' | 'p' }) {
  return <Heading className="ui-section-label">{children}</Heading>;
}
