// What a steps card shows, worked out from its data: how far along it is, the step that matters, its sections, which
// rows show while it is selected, and whether its answers can be sent. The card (`StepsCard.tsx`) only draws this.
import type { Step, StepsData, StepsWho } from '@agent-board/daemon/protocol';
import { answerWords } from '@agent-board/daemon/steps-format';

/** What the card needs to know of the agents it names. */
export interface StepsLookup {
  /** Whether the agent is on the board and its session live. */
  live(sessionId: string): boolean;
  /** The agent's name as it is now, if it is on the board. */
  name(sessionId: string): string | undefined;
}

/**
 * How a step stands: `done` (ticked or answered), `yours` (the user's to do or answer now), `now` (the step the list
 * is on, someone else's), or `later`.
 */
export type StepState = 'done' | 'yours' | 'now' | 'later';

export interface StepView {
  step: Step;
  /** Its place, from 1, as the commands number it. */
  place: number;
  state: StepState;
  /** Who does it, in a word: "you", or the agent's name; null for a question. */
  who: string | null;
  /** Its answer in words, once answered. */
  answer: string | null;
  /** What the step that matters says under its text: whose it is, and who waits on it. */
  note: string;
  /** Whether the user may tick or answer it now. */
  yours: boolean;
}

export interface SectionView {
  /** Its `## heading`; null for the steps before the first. */
  title: string | null;
  steps: StepView[];
  done: number;
  total: number;
}

/** Whether its answers can go to its maker: none to send, a required one missing, ready, or sent and unchanged since. */
export type SendState = { kind: 'none' } | { kind: 'blocked'; place: number } | { kind: 'ready' } | { kind: 'sent' };

export interface StepsView {
  done: number;
  total: number;
  /** Every step done or answered. */
  finished: boolean;
  /** Its maker closed it. */
  closed: boolean;
  sections: SectionView[];
  /** Whether its steps sit under headings. */
  headed: boolean;
  /** The step that matters: the user's first open one, else the first not done; null once finished. */
  matter: StepView | null;
  /** Whether the user answers its questions now (an orchestrator answers a crew member's while it is live). */
  userAnswers: boolean;
  /** Who answers them, in a word. */
  answerer: string;
  send: SendState;
  /** The user's steps not yet done. */
  yoursLeft: number;
  /** The user's steps an agent waits on. */
  waitedOn: number;
}

const isDone = (step: Step) => step.done !== null || step.answer !== null;

/** Who in a word: "you" for the user, else the agent's name as it is now (or as it was). */
const whoWord = (who: StepsWho, lookup: StepsLookup) => (who.kind === 'user' ? 'you' : (lookup.name(who.sessionId) ?? who.name));

/**
 * Whether Send is ready once a words step holds `words` (trimmed; '' clears it), as ⌘↵ in its field saves them first.
 * Words the same as the saved ones change nothing, so a card already sent stays sent.
 */
export function sendsWithWords(data: StepsData, lookup: StepsLookup, stepId: string, words: string): boolean {
  const steps = data.steps.map((step) => {
    const saved = step.answer !== null && 'words' in step.answer.value ? step.answer.value.words : '';
    if (step.id !== stepId || words === saved) return step;
    return { ...step, answer: words === '' ? null : { value: { words }, by: { kind: 'user' } as const, at: new Date().toISOString() } };
  });
  return stepsView({ ...data, steps }, lookup).send.kind === 'ready';
}

export function stepsView(data: StepsData, lookup: StepsLookup): StepsView {
  const closed = data.closedAt !== null;
  const answeredBy = data.answeredBy;
  const userAnswers = answeredBy.kind === 'user' || !lookup.live(answeredBy.sessionId);
  const answerer = userAnswers ? 'you' : whoWord(answeredBy, lookup);
  const waiters = (step: Step) => data.waits.filter((wait) => wait.stepId === step.id).map((wait) => lookup.name(wait.sessionId) ?? 'an agent');
  const mayAct = (step: Step) => !closed && (step.kind === 'todo' ? step.who?.kind === 'user' : userAnswers);

  const firstYours = data.steps.find((step) => !isDone(step) && mayAct(step));
  const firstOpen = data.steps.find((step) => !isDone(step));
  const matterStep = firstYours ?? firstOpen;

  const views = data.steps.map((step, at): StepView => {
    const yours = mayAct(step);
    const state: StepState = isDone(step) ? 'done' : step === matterStep ? (yours ? 'yours' : 'now') : 'later';
    const who = step.who === null ? null : whoWord(step.who, lookup);
    const waiting = waiters(step);
    const waits = waiting.length === 0 ? '' : ` · ${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'}`;
    const note =
      step.kind === 'todo' ? (yours ? `Yours${waits}` : `${who ?? ''}${waits}`) : yours ? 'Yours to answer' : `${answerer} answers`;
    return { step, place: at + 1, state, who, answer: step.answer === null ? null : answerWords(step, step.answer.value), note, yours };
  });

  const sections: SectionView[] = [];
  for (const view of views) {
    const last = sections.at(-1);
    if (last !== undefined && last.title === view.step.section) last.steps.push(view);
    else sections.push({ title: view.step.section, steps: [view], done: 0, total: 0 });
  }
  for (const section of sections) {
    section.total = section.steps.length;
    section.done = section.steps.filter((view) => view.state === 'done').length;
  }

  const questions = data.steps.filter((step) => step.kind !== 'todo');
  const missing = questions.find((step) => step.required && step.answer === null);
  const changedSince = (at: string) => questions.some((step) => step.answer !== null && step.answer.at > at);
  const send: SendState =
    questions.length === 0 || data.madeBy.kind === 'user' || !userAnswers || closed
      ? { kind: 'none' }
      : missing !== undefined
        ? { kind: 'blocked', place: data.steps.indexOf(missing) + 1 }
        : data.sent !== null && !changedSince(data.sent.at)
          ? { kind: 'sent' }
          : { kind: 'ready' };

  const done = views.filter((view) => view.state === 'done').length;
  const yourViews = views.filter((view) => view.yours && view.state !== 'done');
  return {
    done,
    total: views.length,
    finished: views.length > 0 && done === views.length,
    closed,
    sections,
    headed: sections.some((section) => section.title !== null),
    matter: views.find((view) => view.step === matterStep) ?? null,
    userAnswers,
    answerer,
    send,
    yoursLeft: yourViews.length,
    waitedOn: yourViews.filter((view) => waiters(view.step).length > 0).length,
  };
}

/** A row of the card while it is selected: a step (`open` with its controls), a section's head, or a fold. */
export type StepRow =
  | { kind: 'step'; view: StepView; open: boolean }
  | { kind: 'section'; key: string; label: string; count: string; open: boolean; finished: boolean }
  | { kind: 'folded' | 'more'; key: string; label: string; count?: undefined };

/** How many steps show after the one that matters before "+N more". */
const NEXT_SHOWN = 3;

/**
 * The rows of a run of steps around the cursor `at`: the steps before it folded into one line but the last, the
 * cursor's step open, the next three, then "+N more". A fold whose key is in `expanded` shows its
 * steps instead.
 */
function runRows(steps: StepView[], at: number, key: string, expanded: ReadonlySet<string>, cursor: string): StepRow[] {
  const row = (view: StepView): StepRow => ({ kind: 'step', view, open: view.step.id === cursor });
  const before = steps.slice(0, Math.max(at, 0));
  const after = steps.slice(Math.max(at, 0) + 1);
  const rows: StepRow[] = [];
  // The last step before it shows; those before that fold into one line.
  const folded = before.slice(0, -1);
  if (folded.length > 0 && !expanded.has(`done:${key}`)) rows.push({ kind: 'folded', key: `done:${key}`, label: `${folded.length} earlier` });
  else rows.push(...folded.map(row));
  if (before.length > 0) rows.push(row(before.at(-1)!));
  if (at >= 0) rows.push(row(steps[at]!));
  const shown = expanded.has(`more:${key}`) ? after : after.slice(0, NEXT_SHOWN);
  rows.push(...shown.map(row));
  if (shown.length < after.length) rows.push({ kind: 'more', key: `more:${key}`, label: `${after.length - shown.length} more` });
  return rows;
}

/**
 * The rows the card shows selected, its cursor on step `cursor`: with no headings, a run around the cursor; with
 * headings, a head for each section, the one the cursor is in open around it and the rest folded with their counts. A
 * fold's key in `expanded` opens it. A section the user turned by hand (`turnSection`) stays as they left it.
 *
 * With `every` (a card the user made taller, which has room and scrolls), every step shows with no folds, and every
 * section is open but a finished one, which stays folded so the steps still to do come first.
 */
export function stepRows(view: StepsView, cursor: string, expanded: ReadonlySet<string>, { every = false }: { every?: boolean } = {}): StepRow[] {
  const row = (each: StepView): StepRow => ({ kind: 'step', view: each, open: each.step.id === cursor });
  const all = view.sections.flatMap((section) => section.steps);
  if (!view.headed) return every ? all.map(row) : runRows(all, all.findIndex((each) => each.step.id === cursor), '', expanded, cursor);
  // Keyed by its place: a heading may be written twice.
  return view.sections.flatMap((section, index): StepRow[] => {
    const key = String(index);
    const at = section.steps.findIndex((each) => each.step.id === cursor);
    const turned = expanded.has(`section:${key}:open`) ? true : expanded.has(`section:${key}:shut`) ? false : undefined;
    const open = turned ?? (at >= 0 || (every && section.done < section.total));
    const head: StepRow = { kind: 'section', key: `section:${key}`, label: section.title ?? 'First', count: `${section.done}/${section.total}`, open, finished: section.done === section.total };
    if (!open) return [head];
    // A section opened by hand shows all its steps; the cursor's, a run around it.
    const rows = at >= 0 && !every ? runRows(section.steps, at, key, expanded, cursor) : section.steps.map(row);
    return [head, ...rows];
  });
}

/**
 * `expanded` with the section `key` (a section row's key) turned by hand from `open`: the choice itself is kept, not a
 * toggle, so it means the same on a card left at its start and one made taller.
 */
export function turnSection(expanded: ReadonlySet<string>, key: string, open: boolean): ReadonlySet<string> {
  const next = new Set(expanded);
  next.delete(`${key}:open`);
  next.delete(`${key}:shut`);
  next.add(`${key}:${open ? 'shut' : 'open'}`);
  return next;
}

/** How a steps card is drawn at `zoom`: in full, at about half size in larger type, or below about 40% as its icon tile. */
export type ZoomLook = 'full' | 'mid' | 'icon';

/** Below this zoom the card is its icon tile. */
const ICON_ZOOM = 0.4;
/** Below this zoom it keeps only its title, its bar and the user's step, in larger type. */
const MID_ZOOM = 0.6;

export function zoomLook(zoom: number, collapsed: boolean): ZoomLook {
  if (collapsed || zoom < ICON_ZOOM) return 'icon';
  return zoom < MID_ZOOM ? 'mid' : 'full';
}
