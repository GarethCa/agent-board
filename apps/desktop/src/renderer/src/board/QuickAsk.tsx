// The quick ask: an agent's ask of up to four questions, opened from the chip on its tile and drawn beside it. One
// question at a time with its keys; after the last, the answers as chips above Send. Presentational: what it does goes
// through `QuickAskActions`, so the gallery draws it from data alone.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type Ref } from 'react';
import { ChevronLeft, ListTodo, MessageCircleQuestion, MoreHorizontal, Send, SkipForward } from 'lucide-react';
import { MAX_REPLY_LENGTH, MAX_STEP_ANSWER, type AskAnswer } from '@agent-board/daemon/protocol';
import { Button, IconButton, Kbd, Menu } from '../ui';
import { answerText, chipWords, nextAfter, type QuickAskData } from './quick-ask';

/** What the quick ask does: each goes to the daemon, which keeps the answers on the ask until it is sent. */
export interface QuickAskActions {
  /** Answers question `index`, then `onDone` once the daemon has it; for a single question, that sends it. */
  answer(index: number, answer: AskAnswer, onDone?: () => void): void;
  send(): void;
  skip(): void;
  /** Put on the board: the ask becomes a steps card, the agent still waiting. */
  toCard(): void;
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
}: {
  name: string;
  ask: QuickAskData;
  at: number;
  onAt(at: number): void;
  actions: QuickAskActions;
  busy?: boolean;
  drafts?: QuickAskDrafts;
  still?: boolean;
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
  const give = (given: AskAnswer) => {
    drafts?.delete(at);
    actions.answer(at, given, () => {
      if (count > 1) onAt(nextAfter({ ...ask, answers: ask.answers.map((each, index) => (index === at ? given : each)) }, at));
    });
  };
  const answered = ask.answers.filter((each) => each !== null).length;
  const allAnswered = answered === count;
  const send = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // What a control did with the key is its own: a menu that opened, a field's ↵.
    if (event.defaultPrevented || busy) return;
    const target = event.target as HTMLElement;
    const onBox = target === box.current;
    if (question !== undefined && /^[1-9]$/.test(event.key) && target.tagName !== 'TEXTAREA') {
      const option = Number(event.key) - 1;
      if (option < question.options.length) {
        event.preventDefault();
        give({ option });
      }
    } else if (event.key === 'Enter' && question === undefined && (onBox || target === send.current)) {
      // Only on the ask itself or Send: ↵ on ⋯ or on an answer is that control's.
      event.preventDefault();
      actions.send();
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
        <Menu
          align="end"
          entries={[
            { label: 'Put on the board', icon: <ListTodo />, hint: 'As a steps card: answer it there, it still waits', onSelect: actions.toCard },
            { label: count === 1 ? 'Skip it' : 'Skip them all', icon: <SkipForward />, onSelect: actions.skip },
          ]}
        >
          <IconButton icon={<MoreHorizontal />} aria-label="More" title="Put it on the board, or skip it" size="xs" />
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
            <span className="quick-ask-hint">{allAnswered ? 'Click to change' : 'Gaps are skipped'}</span>
            <Button ref={send} size="sm" className="quick-ask-go" icon={<Send />} disabled={busy} onClick={actions.send} data-testid="quick-ask-send">
              {sendWords(answered)} <Kbd>↵</Kbd>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** One question of the ask, open: its options with their keys, and its words field, which keeps a draft by question. */
function Question({
  ask,
  at,
  busy,
  drafts,
  focus,
  onBack,
  give,
}: {
  ask: QuickAskData;
  at: number;
  busy: boolean;
  drafts: QuickAskDrafts | undefined;
  focus: boolean;
  onBack: (() => void) | undefined;
  give(answer: AskAnswer): void;
}) {
  const question = ask.questions[at]!;
  const answer = ask.answers[at] ?? null;
  const count = ask.questions.length;
  const [words, setWords] = useState(() => drafts?.get(at) ?? (answer !== null && 'text' in answer ? answer.text : ''));
  const field = useRef<HTMLTextAreaElement>(null);
  // A question in words takes the keys in its field as it opens, unless the user is typing elsewhere.
  useEffect(() => {
    if (focus && question.options.length === 0 && !typing()) field.current?.focus();
  }, [focus, question.options.length]);
  const answerWords = () => {
    if (words.trim() !== '') give({ text: words.trim() });
  };
  return (
    <>
      <div className="quick-ask-question">
        <MessageCircleQuestion aria-hidden />
        <span>{question.question}</span>
      </div>
      {question.options.length > 0 && (
        <div className="quick-ask-options" role="group" aria-label="Its answers">
          {question.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="quick-ask-option"
              disabled={busy}
              aria-pressed={answer !== null && 'option' in answer && answer.option === index}
              onClick={() => give({ option: index })}
            >
              {index < 9 && <Kbd>{index + 1}</Kbd>}
              <span>{option}</span>
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
        <span className="quick-ask-hint">{question.freeText ? '↵ to answer' : count === 1 ? 'Pick one to answer' : 'Pick one to move on'}</span>
        {/* Shown once there is something to answer with: ↵ does the same. */}
        {question.freeText && words.trim() !== '' && (
          <Button size="xs" className="quick-ask-go" disabled={busy} onClick={answerWords}>
            Answer
          </Button>
        )}
      </div>
    </>
  );
}
