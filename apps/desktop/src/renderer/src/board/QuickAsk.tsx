// The quick ask: an agent's ask of up to four questions, opened from the chip on its tile and drawn beside it. One
// question at a time with its keys; after the last, the answers as chips above Send. It draws Claude's own question
// dialog too (`dialog`): with headers, descriptions, tick boxes where a question takes several answers, and a line saying
// the answer goes to Claude's dialog. Presentational: what it does goes through `QuickAskActions`, so the gallery draws
// it from data alone.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Check, ChevronLeft, ListTodo, MessageCircleQuestion, MoreHorizontal, Send, SkipForward, SquareTerminal } from 'lucide-react';
import { MAX_REPLY_LENGTH, MAX_STEP_ANSWER } from '@agent-board/daemon/protocol';
import { Button, IconButton, Kbd, Menu, type MenuEntry } from '../ui';
import { answerText, chipWords, nextAfter, type QuickAskAnswer, type QuickAskData } from './quick-ask';

/** What the quick ask does: each goes to the daemon, which keeps the answers on the ask until it is sent. */
export interface QuickAskActions {
  /** Answers question `index`, then `onDone` once the daemon has it; for a single question, that sends it. */
  answer(index: number, answer: QuickAskAnswer, onDone?: () => void): void;
  send(): void;
  /** An ask's: skip it all. Claude's dialog has none (its Esc cancels the call, in its terminal). */
  skip?(): void;
  /** An ask's. Put on the board: the ask becomes a steps card, the agent still waiting. */
  toCard?(): void;
  /** Claude's dialog: open the agent, to answer it in its terminal. */
  toTerminal?(): void;
}

/** A dot for each question: filled once answered, ringed where it is open; `label` says where it is in words. */
function Dots({ ask, at, label }: { ask: QuickAskData; at?: number; label?: string }) {
  if (ask.questions.length === 1) return null;
  return (
    <span className="quick-ask-dots" {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label, title: label })}>
      {ask.answers.map((answer, index) => (
        <i key={index} data-done={answer !== null || undefined} data-at={index === at || undefined} />
      ))}
    </span>
  );
}

/** The chip on an asking tile: the speech bubble, how many questions, a dot each, and whether its ask is open. */
export function AskChip({ ask, open, ref, ...rest }: { ask: QuickAskData; open: boolean; ref?: Ref<HTMLButtonElement> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button ref={ref} type="button" className="quick-ask-chip nodrag" data-testid="ask-chip" aria-expanded={open} {...rest}>
      <MessageCircleQuestion aria-hidden />
      {chipWords(ask)}
      <Dots ask={ask} />
      <span className="quick-ask-caret" aria-hidden>
        {open ? '▾' : '▸'}
      </span>
    </button>
  );
}

/** What Send says: how many answers it sends. */
const sendWords = (answers: number) => (answers === 0 ? 'Send' : answers === 1 ? 'Send 1 answer' : `Send ${answers} answers`);

/** What the line under the answers says of Claude's dialog: it takes them all at once. */
export const takesAllWords = (count: number) =>
  `Claude takes ${count === 1 ? 'the answer' : count === 2 ? 'both answers' : `all ${count} answers`} at once, as its Submit does.`;

/** The line under a question of Claude's dialog: where the answer goes, and the way to its terminal. */
function WhereLine({ toTerminal }: { toTerminal: (() => void) | undefined }) {
  return (
    <div className="quick-ask-where" data-testid="quick-ask-where">
      In Claude's dialog · its terminal asks too
      {toTerminal !== undefined && (
        <>
          {' · '}
          <button type="button" className="quick-ask-link" onClick={toTerminal}>
            Answer there
          </button>
        </>
      )}
    </div>
  );
}

/** Whether the user is typing in a field (the ask's own words field, a composer, any input): focus stays there. */
function typing(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return active !== null && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
}

/** Words typed but not yet given, by question, kept while the ask is closed and opened again. */
export type QuickAskDrafts = Map<number, string>;

/**
 * The quick ask open on question `at`, or on the answers and Send at `questions.length`. It takes the keys as it opens
 * and as it moves on, unless `still`, and never from a field being typed in. `busy` while an answer or Send is on its way.
 */
export function QuickAsk({
  name,
  ask,
  at,
  onAt,
  actions,
  busy = false,
  drafts,
  still = false,
  dialog = false,
}: {
  name: string;
  ask: QuickAskData;
  at: number;
  onAt(at: number): void;
  actions: QuickAskActions;
  busy?: boolean;
  drafts?: QuickAskDrafts;
  still?: boolean;
  /** Claude's own question dialog: every question must be answered, and Send sends to its dialog. */
  dialog?: boolean;
}) {
  const count = ask.questions.length;
  const question = ask.questions[at];
  const box = useRef<HTMLDivElement>(null);
  const inWords = question !== undefined && question.options.length === 0;
  // Its keys work as it opens, and as it moves from question to question; a question in words focuses its field itself.
  useEffect(() => {
    if (still || inWords || typing()) return;
    box.current?.focus();
  }, [at, inWords, still]);

  /** Answers the open question and, of several, moves on once the daemon has it: to the next unanswered one, else Send. */
  const give = (given: QuickAskAnswer) => {
    drafts?.delete(at);
    actions.answer(at, given, () => {
      if (count > 1) onAt(nextAfter({ ...ask, answers: ask.answers.map((each, index) => (index === at ? given : each)) }, at));
    });
  };
  const answered = ask.answers.filter((each) => each !== null).length;
  const allAnswered = answered === count;
  // Claude's dialog takes every answer or none: there are no gaps to skip.
  const canSend = !busy && (!dialog || allAnswered);
  const send = useRef<HTMLButtonElement>(null);
  const ticks = useRef<((option: number) => void) | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // What a control did with the key is its own: a menu that opened, a field's ↵.
    if (event.defaultPrevented || busy) return;
    const target = event.target as HTMLElement;
    const onBox = target === box.current;
    if (question !== undefined && /^[1-9]$/.test(event.key) && target.tagName !== 'TEXTAREA') {
      const option = Number(event.key) - 1;
      if (option < question.options.length) {
        event.preventDefault();
        // A question that takes several: its key ticks the option, and Next moves on.
        if (question.multiSelect === true) ticks.current?.(option);
        else give({ option });
      }
    } else if (event.key === 'Enter' && question === undefined && (onBox || target === send.current)) {
      // Only on the ask itself or Send: ↵ on ⋯ or on an answer is that control's.
      event.preventDefault();
      if (canSend) actions.send();
    } else if (onBox && event.key === 'ArrowLeft' && at > 0) {
      onAt(at - 1);
    } else if (onBox && event.key === 'ArrowRight' && at < count && (ask.answers[at] !== null || at === count - 1)) {
      onAt(at + 1);
    }
  };

  return (
    <div ref={box} className="quick-ask" data-testid="quick-ask" data-keys-own tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="quick-ask-head">
        <span className="quick-ask-from" title={`${name} asks`}>
          <b>{name}</b>
          <span>asks</span>
        </span>
        <Dots ask={ask} at={at} label={question === undefined ? 'Your answers' : `Question ${at + 1} of ${count}`} />
        <Menu align="end" entries={menuEntries(actions, count)}>
          <IconButton icon={<MoreHorizontal />} aria-label="More" title={dialog ? 'Answer it in its terminal' : 'Put it on the board, or skip it'} size="xs" />
        </Menu>
      </div>
      {question !== undefined ? (
        // Keyed by its place: each question starts with its own words, never the last one's.
        <Question
          key={at}
          ask={ask}
          at={at}
          busy={busy}
          drafts={drafts}
          focus={!still}
          onBack={at > 0 ? () => onAt(at - 1) : undefined}
          give={give}
          ticks={ticks}
          where={dialog ? <WhereLine toTerminal={actions.toTerminal} /> : null}
        />
      ) : (
        <>
          <div className="quick-ask-chips" role="list" aria-label="Your answers">
            {ask.questions.map((each, index) => (
              <button key={index} type="button" role="listitem" className="quick-ask-answer" title={`${each.question}: change this answer`} onClick={() => onAt(index)}>
                <span>{index + 1}.</span> {answerText(each, ask.answers[index]) ?? 'Skipped'}
              </button>
            ))}
          </div>
          <div className="quick-ask-foot">
            <span className="quick-ask-hint">{allAnswered ? 'Click to change' : dialog ? 'Answer each to send' : 'Gaps are skipped'}</span>
            <Button ref={send} size="sm" className="quick-ask-go" icon={<Send />} disabled={!canSend} onClick={actions.send} data-testid="quick-ask-send">
              {dialog ? 'Send to its dialog' : sendWords(answered)} <Kbd>↵</Kbd>
            </Button>
          </div>
          {dialog && <div className="quick-ask-where">{takesAllWords(count)}</div>}
        </>
      )}
    </div>
  );
}

/** The ⋯ menu: an ask's Put on the board and Skip, or the way to answer Claude's dialog in its terminal. */
function menuEntries(actions: QuickAskActions, count: number): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (actions.toTerminal !== undefined) entries.push({ label: 'Answer in its terminal', icon: <SquareTerminal />, hint: 'Opens the agent', onSelect: actions.toTerminal });
  if (actions.toCard !== undefined) entries.push({ label: 'Put on the board', icon: <ListTodo />, hint: 'As a steps card: answer it there, it still waits', onSelect: actions.toCard });
  if (actions.skip !== undefined) entries.push({ label: count === 1 ? 'Skip it' : 'Skip them all', icon: <SkipForward />, onSelect: actions.skip });
  return entries;
}

/**
 * One question of the ask, open: its options with their keys, and its words field, which keeps a draft by question. A
 * question that takes several answers has tick boxes and Next; its keys tick through `ticks`.
 */
function Question({
  ask,
  at,
  busy,
  drafts,
  focus,
  onBack,
  give,
  ticks,
  where,
}: {
  ask: QuickAskData;
  at: number;
  busy: boolean;
  drafts: QuickAskDrafts | undefined;
  focus: boolean;
  onBack: (() => void) | undefined;
  give(answer: QuickAskAnswer): void;
  ticks: { current: ((option: number) => void) | null };
  where: ReactNode;
}) {
  const question = ask.questions[at]!;
  const answer = ask.answers[at] ?? null;
  const count = ask.questions.length;
  const several = question.multiSelect === true;
  const [words, setWords] = useState(() => drafts?.get(at) ?? (answer !== null && 'text' in answer ? answer.text : ''));
  const [ticked, setTicked] = useState<number[]>(() => (answer !== null && 'options' in answer ? answer.options : []));
  const tick = (option: number) => setTicked((now) => (now.includes(option) ? now.filter((each) => each !== option) : [...now, option].sort((a, b) => a - b)));
  useEffect(() => {
    ticks.current = several ? tick : null;
    return () => {
      ticks.current = null;
    };
  });
  const field = useRef<HTMLTextAreaElement>(null);
  // A question in words takes the keys in its field as it opens, unless the user is typing elsewhere.
  useEffect(() => {
    if (focus && question.options.length === 0 && !typing()) field.current?.focus();
  }, [focus, question.options.length]);
  // Of a question that takes several, words typed are its answer (its Other); else the options ticked.
  const next = () => {
    if (words.trim() !== '') give({ text: words.trim() });
    else if (ticked.length > 0) give({ options: ticked });
  };
  const answerWords = () => {
    if (several) next();
    else if (words.trim() !== '') give({ text: words.trim() });
  };
  const descriptions = question.descriptions ?? [];
  return (
    <>
      <div className="quick-ask-question">
        <MessageCircleQuestion aria-hidden />
        <span>
          {question.header !== undefined && question.header !== '' && <span className="quick-ask-header">{question.header}</span>}
          {question.question}
          {several && <span className="quick-ask-any"> (any)</span>}
        </span>
      </div>
      {question.options.length > 0 && (
        <div className="quick-ask-options" role="group" aria-label="Its answers">
          {question.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="quick-ask-option"
              disabled={busy}
              {...(several
                ? { role: 'checkbox', 'aria-checked': ticked.includes(index), 'data-several': true, onClick: () => tick(index) }
                : { 'aria-pressed': answer !== null && 'option' in answer && answer.option === index, onClick: () => give({ option: index }) })}
            >
              {several ? (
                <span className="quick-ask-tick" aria-hidden>
                  {ticked.includes(index) && <Check />}
                </span>
              ) : (
                index < 9 && <Kbd>{index + 1}</Kbd>
              )}
              <span className="quick-ask-label">
                {option}
                {descriptions[index] !== undefined && descriptions[index] !== '' && <small>{descriptions[index]}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {question.freeText && (
        <textarea
          ref={field}
          className="quick-ask-words"
          aria-label={question.options.length === 0 ? question.question : 'Or in your words'}
          placeholder={question.options.length === 0 ? 'In your words' : 'Or in your words'}
          rows={2}
          // Of several, kept on the ask until sent: no longer than a steps card's answer, where it may go.
          maxLength={count > 1 ? MAX_STEP_ANSWER : MAX_REPLY_LENGTH}
          value={words}
          onChange={(event) => {
            setWords(event.target.value);
            drafts?.set(at, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (!busy) answerWords();
          }}
        />
      )}
      <div className="quick-ask-foot">
        {onBack !== undefined && (
          <button type="button" className="quick-ask-back" onClick={onBack}>
            <ChevronLeft aria-hidden />
            Back
          </button>
        )}
        <span className="quick-ask-hint">
          {several ? 'Tick any, or in your words' : question.freeText ? '↵ to answer' : count === 1 ? 'Pick one to answer' : 'Pick one to move on'}
        </span>
        {several ? (
          <Button size="xs" className="quick-ask-go" disabled={busy || (ticked.length === 0 && words.trim() === '')} onClick={next} data-testid="quick-ask-next">
            {count === 1 ? 'Answer' : 'Next'} <Kbd>↵</Kbd>
          </Button>
        ) : (
          // Shown once there is something to answer with: ↵ does the same.
          question.freeText &&
          words.trim() !== '' && (
            <Button size="xs" className="quick-ask-go" disabled={busy} onClick={answerWords}>
              Answer
            </Button>
          )
        )}
      </div>
      {where}
    </>
  );
}
