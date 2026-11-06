import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Circle, CircleDot, Link, ListChecks, ListTodo, MessageSquareText, Send, ToggleRight, ArrowUpDown } from 'lucide-react';
import type { Step, StepAnswer, StepsData } from '@agent-board/daemon/protocol';
import { Button, ErrorText, Kbd } from '../../ui';
import { fromStepLink, stepLinkUrl } from './step-link';
import { sendsWithWords, stepRows, stepsView, type StepRow, type StepsLookup, type StepsView, type StepView, type ZoomLook } from './steps-view';

/**
 * Answers `step` by `key`, as the card's keys do: Space ticks a to-do, 1–9 picks a choice (or toggles one of any), and
 * 1 or 2 is Yes or No. True if the key did.
 */
function answerByKey(step: Step, key: string, actions: Pick<StepsCardActions, 'answer' | 'tick'>): boolean {
  if (key === ' ' && step.kind === 'todo') return (actions.tick(step.id, step.done === null), true);
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  if (digit < 0) return false;
  if (step.kind === 'one' && digit < step.choices.length) return (actions.answer(step.id, { one: digit }), true);
  if (step.kind === 'yes-no' && digit < 2) return (actions.answer(step.id, { yes: digit === 0 }), true);
  if (step.kind === 'any' && digit < step.choices.length) {
    const now = step.answer !== null && 'any' in step.answer.value ? step.answer.value.any : [];
    return (actions.answer(step.id, { any: now.includes(digit) ? now.filter((each) => each !== digit) : [...now, digit] }), true);
  }
  return false;
}

/** What the card asks of the board: the user's answers, ticks and Send, and leaving it. */
export interface StepsCardActions {
  answer(stepId: string, answer: StepAnswer | null): void;
  tick(stepId: string, done: boolean): void;
  send(): void;
  /** Takes the keyboard into the card, as ↵ does on the board. */
  stepIn(): void;
  /** Gives the keyboard back to the board (esc). */
  leave(): void;
  /** Saves the steps typed into an empty card of the user's. Returns why they can't be read, if they can't. */
  write?(text: string): Promise<string | undefined>;
}

export interface StepsCardProps {
  data: StepsData;
  lookup: StepsLookup;
  look: ZoomLook;
  /** Selected: its rows show. */
  selected: boolean;
  /** Stepped into: its keys are its own. */
  steppedIn: boolean;
  /** Typing its steps in, for an empty card of the user's. */
  writing: boolean;
  actions: StepsCardActions;
  /** Why the last answer, tick or Send failed. */
  error?: string;
}

/** Each kind of step's mark, so a row reads as what it asks before its text. */
const KIND_ICON: Record<Step['kind'], ReactNode> = {
  todo: <Circle />,
  one: <CircleDot />,
  any: <ListChecks />,
  'yes-no': <ToggleRight />,
  order: <ArrowUpDown />,
  words: <MessageSquareText />,
};

/** What a kind of question asks, for its row's tooltip and a screen reader. */
const KIND_NAME: Record<Step['kind'], string> = { todo: 'To-do', one: 'Pick one', any: 'Pick any', 'yes-no': 'Yes or no', order: 'Put in order', words: 'In your words' };

const EXAMPLE = '## Before\n- [ ] Pull main\n? Ship on Friday? [yes/no]\n? Which store? [Redis | SQLite]';

/** The bar: one segment, or one a section, each filled as far as its steps are done. */
function Bar({ view }: { view: StepsView }) {
  const parts = view.headed ? view.sections : [{ title: null, done: view.done, total: view.total }];
  return (
    <div className="steps-bar" aria-hidden>
      {parts.map((part, at) => (
        <i key={at} style={{ flexGrow: part.total }}>
          <b style={{ width: `${part.total === 0 ? 0 : (100 * part.done) / part.total}%` }} data-full={part.done === part.total || undefined} />
        </i>
      ))}
    </div>
  );
}

/** A step's dot: ticked, the user's, the one it is on, or later; a question's is square. */
function Dot({ view }: { view: StepView }) {
  return (
    <span className="steps-dot" data-state={view.state} data-question={view.step.kind !== 'todo' || undefined}>
      {view.state === 'done' && <Check />}
    </span>
  );
}

/** The card's head: its glyph, title and count, or a tick once finished. */
function Head({ data, view }: { data: StepsData; view: StepsView }) {
  return (
    <div className="steps-head">
      <span className="steps-glyph" data-finished={view.finished || undefined}>
        <ListTodo />
      </span>
      <b className="steps-title">{data.title}</b>
      <span className="steps-count" data-testid="steps-count">
        {view.closed ? 'Closed' : view.finished ? 'Done' : <>{view.done}<span>/{view.total}</span></>}
      </span>
    </div>
  );
}

/** The line at rest: the step that matters, the user's in orange with its button, or how the list stands. */
function NowLine({ view, actions }: { view: StepsView; actions: StepsCardActions }) {
  const matter = view.matter;
  if (matter === null) {
    const said = view.closed ? 'Closed by its maker' : view.send.kind === 'ready' ? 'Every answer in: ready to send' : view.send.kind === 'sent' ? 'Answers sent' : 'All done';
    return (
      <div className="steps-now" data-tone={view.send.kind === 'ready' ? 'yours' : 'calm'} data-testid="steps-now">
        <span className="steps-dot" data-state="done">
          <Check />
        </span>
        <span className="steps-now-text">
          <b>{said}</b>
        </span>
        {view.send.kind === 'ready' && (
          <Button size="sm" variant="primary" className="steps-go nodrag" onClick={actions.send}>
            <Send /> Send
          </Button>
        )}
      </div>
    );
  }
  const yours = matter.state === 'yours';
  return (
    <div className="steps-now" data-tone={yours ? 'yours' : 'calm'} data-testid="steps-now">
      <Dot view={matter} />
      <span className="steps-now-text">
        <b>{matter.step.text}</b>
        <span>{matter.note}</span>
        {matter.step.link !== null && <StepLink link={matter.step.link} />}
      </span>
      {yours && matter.step.kind === 'todo' && (
        <Button size="sm" variant="primary" className="steps-go nodrag" onClick={() => actions.tick(matter.step.id, true)}>
          <Check /> Done
        </Button>
      )}
      {yours && matter.step.kind !== 'todo' && (
        <Button size="sm" variant="primary" className="steps-go nodrag" onClick={actions.stepIn}>
          Answer <ChevronRight />
        </Button>
      )}
    </div>
  );
}

/** The order a put-in-order question shows: its answer's, else as offered. */
const orderOf = (step: Step) => (step.answer !== null && 'order' in step.answer.value ? step.answer.value.order : step.choices.map((_, at) => at));

/** A to-do's link: a button that opens it in the browser when it is a web link, else just said. Never ticks or steps past its step. */
export function StepLink({ link }: { link: string }) {
  const url = stepLinkUrl(link);
  const [failed, setFailed] = useState(false);
  if (url === null) {
    return (
      <span className="steps-link" title={link}>
        <Link /> {link}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="steps-link steps-link-open nodrag"
      data-testid="steps-link"
      title={`Open ${link}`}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setFailed(false);
        void window.agentBoard.trackers.openLink(url).catch(() => setFailed(true));
      }}
    >
      <Link /> {failed ? 'Couldn’t open the link' : link}
    </button>
  );
}

/** The controls of the open step, for the kind of step it is, with the keys they take. */
function Controls({ view, actions, onNext, keys, sends }: { view: StepView; actions: StepsCardActions; onNext(): void; keys: boolean; sends(stepId: string, words: string): boolean }) {
  const { step } = view;
  const value = step.answer?.value;
  const saved = value !== undefined && 'words' in value ? value.words : '';
  const [words, setWords] = useState(saved);
  const field = useRef<HTMLTextAreaElement>(null);
  // A new step, or its answer saved in words that changed, shows that; never over what is being typed.
  useEffect(() => {
    if (document.activeElement !== field.current) setWords(saved);
  }, [step.id, saved]);
  const saveWords = () => {
    const text = words.trim();
    if (text === '' && step.answer === null) return;
    if (text !== (value !== undefined && 'words' in value ? value.words : '')) actions.answer(step.id, text === '' ? null : { words: text });
  };

  if (step.kind === 'todo') {
    return (
      <div className="steps-actions">
        {step.link !== null && <StepLink link={step.link} />}
        <span className="steps-spacer" />
        {view.yours && (
          <Button size="sm" variant={step.done === null ? 'primary' : 'secondary'} className="steps-go nodrag" onClick={() => actions.tick(step.id, step.done === null)}>
            {step.done === null ? (
              <>
                <Check /> Done {keys && <Kbd>Space</Kbd>}
              </>
            ) : (
              'Untick'
            )}
          </Button>
        )}
      </div>
    );
  }
  if (!view.yours) return null;
  const picked = (at: number) =>
    value !== undefined && (('one' in value && value.one === at) || ('any' in value && value.any.includes(at)) || ('yes' in value && value.yes === (at === 0)));
  const pick = (at: number) => {
    if (step.kind === 'one') actions.answer(step.id, { one: at });
    else if (step.kind === 'yes-no') actions.answer(step.id, { yes: at === 0 });
    else if (step.kind === 'any') {
      const now = value !== undefined && 'any' in value ? value.any : [];
      actions.answer(step.id, { any: now.includes(at) ? now.filter((each) => each !== at) : [...now, at] });
    }
  };
  const order = orderOf(step);
  const move = (at: number, by: number) => {
    const to = at + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[at], next[to]] = [next[to]!, next[at]!];
    actions.answer(step.id, { order: next });
  };
  return (
    <div className="steps-controls">
      {(step.kind === 'one' || step.kind === 'any') && (
        <div className="steps-options" role={step.kind === 'one' ? 'radiogroup' : 'group'} aria-label={step.text}>
          {step.choices.map((choice, at) => (
            <button key={choice} type="button" className="steps-option nodrag" aria-pressed={picked(at)} onClick={() => pick(at)}>
              {keys && <Kbd>{at + 1}</Kbd>}
              {choice}
            </button>
          ))}
        </div>
      )}
      {step.kind === 'yes-no' && (
        <div className="steps-options steps-yes-no" role="radiogroup" aria-label={step.text}>
          {['Yes', 'No'].map((label, at) => (
            <button key={label} type="button" className="steps-option nodrag" aria-pressed={picked(at)} onClick={() => pick(at)}>
              {keys && <Kbd>{at + 1}</Kbd>}
              {label}
            </button>
          ))}
        </div>
      )}
      {step.kind === 'order' && (
        <ol className="steps-rank" aria-label={step.text}>
          {order.map((index, at) => (
            <li key={index} className="steps-rank-row">
              <b>{at + 1}</b>
              <span>{step.choices[index]}</span>
              <span className="steps-rank-move">
                <button type="button" className="nodrag" aria-label={`Move ${step.choices[index]} up`} disabled={at === 0} onClick={() => move(at, -1)}>
                  <ArrowUp />
                </button>
                <button type="button" className="nodrag" aria-label={`Move ${step.choices[index]} down`} disabled={at === order.length - 1} onClick={() => move(at, 1)}>
                  <ArrowDown />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {step.kind === 'words' && (
        <textarea
          ref={field}
          className="steps-words nodrag nowheel"
          aria-label={step.text}
          placeholder="In your words"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onBlur={saveWords}
          onKeyDown={(event) => {
            // ↵ keeps the words and moves on, ⌘↵ keeps them and sends, esc keeps them and leaves the card.
            const send = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
            if (event.key !== 'Escape' && event.key !== 'Enter') return;
            if (event.key === 'Enter' && event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            saveWords();
            if (event.key === 'Escape') actions.leave();
            else if (send) {
              if (sends(step.id, words.trim())) actions.send();
            }
            else onNext();
          }}
        />
      )}
      <div className="steps-actions">
        {step.kind === 'order' && step.answer === null && (
          <button type="button" className="steps-quiet nodrag" onClick={() => actions.answer(step.id, { order })}>
            Keep this order
          </button>
        )}
        {step.answer !== null && (
          <button type="button" className="steps-quiet nodrag" onClick={() => actions.answer(step.id, null)}>
            Clear answer
          </button>
        )}
        <span className="steps-spacer" />
        <button
          type="button"
          className="steps-quiet nodrag"
          onClick={() => {
            if (step.kind === 'words') saveWords();
            onNext();
          }}
        >
          {step.answer === null && !step.required ? 'Skip' : 'Next'} {keys && <Kbd>↵</Kbd>}
        </button>
      </div>
    </div>
  );
}

/** One row of the open card. */
function Row({ row, onCursor, onToggle, actions, onNext, keys, sends }: { row: StepRow; onCursor(id: string): void; onToggle(key: string): void; actions: StepsCardActions; onNext(): void; keys: boolean; sends(stepId: string, words: string): boolean }) {
  if (row.kind === 'section') {
    return (
      <button type="button" className="steps-section nodrag" aria-expanded={row.open} data-finished={row.finished || undefined} onClick={() => onToggle(row.key)}>
        <ChevronRight className="steps-chevron" />
        <span>{row.label}</span>
        <span className="steps-section-count">
          {row.finished && <Check />}
          {row.count}
        </span>
      </button>
    );
  }
  if (row.kind !== 'step') {
    return (
      <button type="button" className="steps-fold nodrag" onClick={() => onToggle(row.key)}>
        {row.kind === 'more' ? `+ ${row.label}` : `${row.label} ▸`}
      </button>
    );
  }
  const { view, open } = row;
  if (open) {
    return (
      <div className="steps-open" data-tone={view.yours && view.state !== 'done' ? 'yours' : 'now'} data-testid="steps-open" data-step={view.place}>
        <div className="steps-open-head">
          <span className="steps-kind" title={KIND_NAME[view.step.kind]}>
            {KIND_ICON[view.step.kind]}
          </span>
          <span className="steps-open-text">{view.step.text}</span>
          {view.step.required && <span className="steps-required">Required</span>}
        </div>
        <div className="steps-open-note">{view.state === 'done' && view.answer !== null ? `Answered: ${view.answer}` : view.note}</div>
        <Controls view={view} actions={actions} onNext={onNext} keys={keys} sends={sends} />
      </div>
    );
  }
  return (
    <button type="button" className="steps-row nodrag" data-state={view.state} data-question={view.step.kind !== 'todo' || undefined} title={KIND_NAME[view.step.kind]} onClick={() => onCursor(view.step.id)}>
      <Dot view={view} />
      <span className="steps-row-text">{view.step.text}</span>
      {view.answer !== null && <span className="steps-answer">{view.answer}</span>}
    </button>
  );
}

/** The foot of the open card: Send once it can go, or what is the user's. */
function Foot({ view, steppedIn, actions }: { view: StepsView; steppedIn: boolean; actions: StepsCardActions }) {
  const keys = steppedIn ? '1–9 picks · ↑↓ steps · esc leaves' : '↵ to answer by key';
  const { send } = view;
  return (
    <div className="steps-foot">
      <span className="steps-foot-text">
        {send.kind === 'blocked'
          ? `Step ${send.place} is required before Send`
          : send.kind === 'sent'
            ? 'Answers sent · change one to send again'
            : !view.userAnswers
              ? `${view.answerer} answers its questions`
              : view.yoursLeft > 0
                ? `Yours: ${view.yoursLeft} left${view.waitedOn > 0 ? ` · ${view.waitedOn} waited on` : ''}`
                : keys}
      </span>
      {(send.kind === 'ready' || send.kind === 'blocked') && (
        <Button size="sm" variant="primary" className="nodrag" disabled={send.kind === 'blocked'} onClick={actions.send} data-testid="steps-send">
          <Send /> Send <Kbd>⌘↵</Kbd>
        </Button>
      )}
    </div>
  );
}

/** An empty card of the user's, taking its steps typed one a line. */
function Writing({ actions }: { actions: StepsCardActions }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const [saving, setSaving] = useState(false);
  const save = () => {
    if (actions.write === undefined || saving) return;
    setSaving(true);
    void actions.write(text).then((why) => {
      setSaving(false);
      setProblem(why);
    });
  };
  return (
    <div className="steps-writing">
      <p className="steps-writing-hint">
        One step a line: <code>- [ ] a to-do</code>, <code>? a question [a | b]</code>, <code>[yes/no]</code>, <code>## a section</code>.
      </p>
      <textarea
        ref={field}
        className="steps-words steps-writing-field nodrag nowheel"
        aria-label="Steps, one a line"
        placeholder={EXAMPLE}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
          if (event.key === 'Escape') actions.leave();
        }}
      />
      {problem !== undefined && <ErrorText>{problem}</ErrorText>}
      <div className="steps-actions">
        <span className="steps-spacer" />
        <Button size="sm" variant="primary" className="nodrag" disabled={text.trim() === '' || saving} onClick={save}>
          Add steps <Kbd>⌘↵</Kbd>
        </Button>
      </div>
    </div>
  );
}

/**
 * A steps card: an ordered list of questions and to-dos. At rest, its title and count, a bar and the step that matters;
 * selected, its rows, the step it is on open with its controls; zoomed out, fewer lines in larger type, then its icon
 * tile. Stepped into (↵), it takes 1–9, Space, ↑↓, ↵ and ⌘↵ for itself, and esc gives the keys back.
 */
export function StepsCard({ data, lookup, look, selected, steppedIn, writing, actions, error }: StepsCardProps) {
  const view = useMemo(() => stepsView(data, lookup), [data, lookup]);
  const [cursor, setCursor] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const at = cursor !== undefined && data.steps.some((step) => step.id === cursor) ? cursor : (view.matter?.step.id ?? data.steps.at(-1)?.id ?? '');
  // Picked up, it opens on the step that matters and stays there as it is answered, until moved on; put down, it
  // opens on the step that matters next time.
  useEffect(() => {
    if (selected) setCursor((now) => now ?? view.matter?.step.id);
    else {
      setCursor(undefined);
      setExpanded(new Set());
    }
  }, [selected, view.matter]);
  useEffect(() => {
    if (steppedIn) root.current?.focus();
  }, [steppedIn]);

  const toggle = (key: string) =>
    setExpanded((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const all = view.sections.flatMap((section) => section.steps);
  const moveCursor = (by: number) => {
    const index = all.findIndex((each) => each.step.id === at);
    const to = all[Math.min(all.length - 1, Math.max(0, index + by))];
    if (to !== undefined) setCursor(to.step.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!steppedIn || (event.target as HTMLElement).tagName === 'TEXTAREA' || fromStepLink(event.target as HTMLElement)) return;
    const current = all.find((each) => each.step.id === at);
    const handled = (() => {
      if (event.key === 'Escape') return (actions.leave(), true);
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return view.send.kind === 'ready' && (actions.send(), true);
      if (event.key === 'ArrowDown' && !event.altKey) return (moveCursor(1), true);
      if (event.key === 'ArrowUp' && !event.altKey) return (moveCursor(-1), true);
      if (event.key === 'Enter') return (moveCursor(1), true);
      if (current === undefined || !current.yours) return false;
      return answerByKey(current.step, event.key, actions);
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const yours = view.matter?.state === 'yours' || view.send.kind === 'ready';
  if (look === 'icon') {
    return (
      <div className="steps-icon" data-testid="steps-card" data-look="icon" data-yours={yours || undefined} data-finished={view.finished || undefined}>
        <span className="steps-icon-glyph">
          <ListTodo />
          <span className="steps-icon-count">{view.finished ? <Check /> : `${view.done}/${view.total}`}</span>
        </span>
        <span className="steps-icon-name">{data.title}</span>
      </div>
    );
  }
  if (look === 'mid') {
    return (
      <div className="steps-card" data-testid="steps-card" data-look="mid">
        <b className="steps-mid-title">{data.title}</b>
        <Bar view={view} />
        {view.matter?.state === 'yours' && <span className="steps-mid-yours">● Yours: {view.matter.step.text}</span>}
      </div>
    );
  }
  const empty = data.steps.length === 0;
  return (
    <div
      ref={root}
      className="steps-card"
      data-testid="steps-card"
      data-look="full"
      data-selected={selected || undefined}
      data-stepped-in={steppedIn || undefined}
      // The board's keys stand back while the card has the keyboard (`isTyping`).
      data-keys-own={steppedIn || writing || undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <Head data={data} view={view} />
      {!empty && <Bar view={view} />}
      {writing ? (
        <Writing actions={actions} />
      ) : empty ? (
        <div className="steps-empty">Double-click to type its steps</div>
      ) : selected ? (
        <>
          <div className="steps-rows nowheel" data-testid="steps-rows">
            {stepRows(view, at, expanded).map((row) => (
              <Row key={row.kind === 'step' ? row.view.step.id : row.key} row={row} onCursor={setCursor} onToggle={toggle} actions={actions} onNext={() => moveCursor(1)} keys={steppedIn} sends={(stepId, words) => sendsWithWords(data, lookup, stepId, words)} />
            ))}
          </div>
          {error !== undefined && <ErrorText className="steps-error">{error}</ErrorText>}
          <Foot view={view} steppedIn={steppedIn} actions={actions} />
        </>
      ) : (
        <NowLine view={view} actions={actions} />
      )}
    </div>
  );
}

/** What Send says: how many answers it sends. */
const sendWords = (answers: number) => (answers === 0 ? 'Send' : answers === 1 ? 'Send 1 answer' : `Send ${answers} answers`);

/**
 * A set's questions stepped through one at a time, away from its card: in Needs you and above the asking agent's
 * composer, as the quick ask is. Each question answers as on the card, with its controls and keys (1–9, ↵ for the
 * next, ⌘↵ to send). Send shows once it can send; a required question is named only once the user reaches it.
 */
export function StepsStepper({
  data,
  lookup,
  actions,
  busy = false,
  focus = false,
  error,
}: {
  data: StepsData;
  lookup: StepsLookup;
  actions: StepsCardActions;
  busy?: boolean;
  /** Takes the keys as it opens: when the user opened it (Answer), never when it shows by itself beside a composer. */
  focus?: boolean;
  error?: string;
}) {
  const view = useMemo(() => stepsView(data, lookup), [data, lookup]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const questions = view.sections.flatMap((section) => section.steps).filter((each) => each.step.kind !== 'todo');
  const [cursor, setCursor] = useState(() => (questions.find((each) => each.step.answer === null) ?? questions[0])?.step.id);
  const at = Math.max(0, questions.findIndex((each) => each.step.id === cursor));
  const open = questions[at];
  if (open === undefined) return null;
  const move = (by: number) => setCursor(questions[Math.min(questions.length - 1, Math.max(0, at + by))]?.step.id);
  const answered = questions.filter((each) => each.step.answer !== null).length;
  const last = at === questions.length - 1;
  // Send shows once it can send, on the last question or with every question answered: never ahead of the user.
  const ready = view.send.kind === 'ready' && (last || answered === questions.length);
  // A required question is named once the user is on it or past it; before then, how far along they are.
  const blocked = view.send.kind === 'blocked' && open.place >= view.send.place ? view.send.place : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as HTMLElement).tagName === 'TEXTAREA' || fromStepLink(event.target as HTMLElement)) return;
    const handled = (() => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return view.send.kind === 'ready' && !busy && (actions.send(), true);
      // ↵ on the stepper itself: a focused Back or choice keeps its own ↵, as in the quick ask.
      if (event.key === 'Enter') return event.target === box.current && (last ? ready && !busy && (actions.send(), true) : (move(1), true));
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return (move(1), true);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return (move(-1), true);
      return answerByKey(open.step, event.key, actions);
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <div ref={box} className="steps-stepper" data-testid="steps-stepper" data-keys-own tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="steps-stepper-head">
        <span className="steps-glyph" aria-hidden>
          <ListTodo />
        </span>
        <b title={data.title}>{data.title}</b>
        <span className="steps-stepper-dots" role="img" aria-label={`Question ${at + 1} of ${questions.length}`} title={`Question ${at + 1} of ${questions.length}`}>
          {questions.map((each, index) => (
            <i key={each.step.id} data-done={each.step.answer !== null || undefined} data-at={index === at || undefined} />
          ))}
        </span>
      </div>
      <div className="steps-stepper-question" data-testid="steps-open" data-step={open.place}>
        <div className="steps-open-head">
          <span className="steps-kind" title={KIND_NAME[open.step.kind]}>
            {KIND_ICON[open.step.kind]}
          </span>
          <span className="steps-open-text">{open.step.text}</span>
          {open.step.required && <span className="steps-required">Required</span>}
        </div>
        {/* Keyed by its step: each question starts from its own answer. */}
        <Controls key={open.step.id} view={open} actions={actions} onNext={() => move(1)} keys sends={(stepId, words) => sendsWithWords(data, lookup, stepId, words)} />
      </div>
      <div className="steps-stepper-foot">
        {at > 0 && (
          <button type="button" className="quick-ask-back" onClick={() => move(-1)}>
            <ChevronLeft aria-hidden />
            Back
          </button>
        )}
        <span className="steps-stepper-hint">{blocked !== undefined ? `Step ${blocked} is required` : view.send.kind === 'sent' ? 'Answers sent' : `${answered} of ${questions.length} answered`}</span>
        {ready && (
          <Button size="sm" className="steps-stepper-send" icon={<Send />} disabled={busy} onClick={actions.send} data-testid="steps-stepper-send">
            {sendWords(answered)} {last && <Kbd>↵</Kbd>}
          </Button>
        )}
      </div>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
