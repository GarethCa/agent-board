import { useMemo, useState, type HTMLAttributes, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Check, ListTodo, Send, X } from 'lucide-react';
import type { StepsData } from '@agent-board/daemon/protocol';
import { Button, ErrorText, IconButton } from '../../ui';
import { Bar, Dot, KIND_ICON, KIND_NAME, StepLink, type StepsCardActions } from './StepsCard';
import { stepsView, type StepsLookup, type StepView } from './steps-view';

/** What a step's state reads as, beside it. */
const STATE_WORD: Record<StepView['state'], string> = { done: 'Done', yours: 'Yours', now: 'Now', later: '' };

interface StepsFullProps {
  data: StepsData;
  lookup: StepsLookup;
  /** Ticks and Send, as on the card. */
  actions: Pick<StepsCardActions, 'tick' | 'send'>;
  /** Why the last tick or Send failed. */
  error?: string;
  onClose(): void;
  /** In the page, not over the board: for the steps gallery's shot. */
  inline?: boolean;
}

/** One step in full: its state, place and kind, its whole text and link, and its answer or whose it is. */
function FullStep({ view, tick }: { view: StepView; tick: StepsCardActions['tick'] }) {
  const { step } = view;
  const tickable = step.kind === 'todo' && view.yours;
  return (
    <li className="steps-full-step" data-state={view.state} data-question={view.step.kind !== 'todo' || undefined} data-testid="steps-full-step">
      {tickable ? (
        <button type="button" className="steps-full-tick" aria-label={step.done === null ? `Tick “${step.text}”` : `Untick “${step.text}”`} aria-pressed={step.done !== null} onClick={() => tick(step.id, step.done === null)}>
          <Dot view={view} />
        </button>
      ) : (
        <Dot view={view} />
      )}
      <span className="steps-full-place">{view.place}</span>
      <span className="steps-kind" title={KIND_NAME[step.kind]} aria-label={KIND_NAME[step.kind]}>
        {KIND_ICON[step.kind]}
      </span>
      <span className="steps-full-text">
        <span>
          {step.text}
          {step.required && <span className="steps-required">Required</span>}
        </span>
        {step.link !== null && <StepLink link={step.link} />}
        <span className="steps-full-note">{view.answer !== null ? `Answered: ${view.answer}` : view.note}</span>
      </span>
      {STATE_WORD[view.state] !== '' && <span className="steps-full-state">{STATE_WORD[view.state]}</span>}
    </li>
  );
}

/**
 * A steps card in full, over the board: every step under its section, whole, with its state, its answer or whose it is,
 * and a tick for the user's own to-dos. Esc, the close button or a click outside closes it.
 */
export function StepsFull(props: StepsFullProps) {
  const { inline = false, onClose } = props;
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  if (inline)
    return (
      <RadixDialog.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
        <FullBody {...props} />
      </RadixDialog.Root>
    );
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-scrim" />
        <RadixDialog.Content
          asChild
          aria-describedby={undefined}
          // The steps take the focus, so ↑↓ scroll them and esc closes the view: on Close, its tooltip would open
          // and take the first esc.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.target as HTMLElement | null)?.querySelector<HTMLElement>('.steps-full-body')?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
          }}
        >
          <FullBody {...props} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** What the dialog gives the element it is drawn as, over the board. */
type Frame = Omit<HTMLAttributes<HTMLDivElement>, keyof StepsFullProps> & { ref?: Ref<HTMLDivElement> };

/** The card in full: its head, bar, sections and foot. */
function FullBody({ data, lookup, actions, error, onClose, inline = false, ...frame }: StepsFullProps & Frame) {
  const view = useMemo(() => stepsView(data, lookup), [data, lookup]);
  return (
    <div
      {...frame}
      className="ui-card steps-full"
      role="dialog"
      aria-label={`${data.title}: every step`}
      data-inline={inline || undefined}
      data-testid="steps-full"
    >
      <div className="steps-full-head">
        <span className="steps-glyph" data-finished={view.finished || undefined}>
          <ListTodo />
        </span>
        <RadixDialog.Title className="steps-full-title">{data.title}</RadixDialog.Title>
        <span className="steps-count">{view.closed ? 'Closed' : view.finished ? 'Done' : <>{view.done}<span>/{view.total}</span></>}</span>
        {inline ? (
          <IconButton icon={<X />} size="sm" aria-label="Close" onClick={onClose} />
        ) : (
          <RadixDialog.Close asChild>
            <IconButton icon={<X />} size="sm" aria-label="Close" tooltip="Close · esc" />
          </RadixDialog.Close>
        )}
      </div>
      {data.steps.length > 0 && <Bar view={view} />}
      <div className="steps-full-body" tabIndex={-1}>
        {data.steps.length === 0 && <p className="steps-full-none">No steps yet</p>}
        {view.sections.map((section, index) => (
          <section key={index} className="steps-full-section" aria-label={section.title ?? (view.headed ? 'First' : 'Steps')}>
            {view.headed && (
              <h3 className="steps-full-section-head" data-finished={section.done === section.total || undefined}>
                <span>{section.title ?? 'First'}</span>
                <span className="steps-section-count">
                  {section.done === section.total && <Check />}
                  {section.done}/{section.total}
                </span>
              </h3>
            )}
            <ol className="steps-full-steps">
              {section.steps.map((each) => (
                <FullStep key={each.step.id} view={each} tick={actions.tick} />
              ))}
            </ol>
          </section>
        ))}
      </div>
      {(error !== undefined || view.send.kind === 'ready' || view.send.kind === 'blocked') && (
        <div className="steps-full-foot">
          {error !== undefined && <ErrorText>{error}</ErrorText>}
          <span className="steps-spacer" />
          {view.send.kind === 'blocked' && <span className="steps-full-note">Step {view.send.place} is required before Send</span>}
          {(view.send.kind === 'ready' || view.send.kind === 'blocked') && (
            <Button size="sm" variant="primary" disabled={view.send.kind === 'blocked'} onClick={actions.send}>
              <Send /> Send
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

