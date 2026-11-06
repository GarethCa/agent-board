// The steps line format, which people type and agents write alike: `- [ ] text @who -> link` for a to-do (`[x]` once
// done); `? text [a | b]`, `[any: a | b]`, `[yes/no]`, `[order: a | b]`, or no brackets for an answer in words, for a
// question; `(required)` on either; `## heading` to start a section and one `# title`. A pasted bulleted or numbered
// list reads as to-dos.
import {
  MAX_PLAN_TITLE_LENGTH,
  MAX_STEP_CHOICES,
  MAX_STEP_RANKED,
  MAX_STEP_TEXT,
  MAX_STEPS,
  MAX_STEPS_QUESTIONS,
  MIN_STEP_CHOICES,
  type Step,
  type StepAnswer,
  type StepKind,
  type StepsWho,
} from './protocol.ts';

/** A step as read from its line: `who` as written after its `@`, or null for none. */
export interface ParsedStep {
  kind: StepKind;
  text: string;
  section: string | null;
  required: boolean;
  choices: string[];
  who: string | null;
  link: string | null;
  done: boolean;
}

/** A line that isn't in the format. */
export class StepsFormatError extends Error {}

const BULLET = /^(?:[-*+]|\d{1,3}[.)])\s+/;
const CHECKBOX = /^\[([ xX]?)\]\s*/;
/** `(required)` where the format puts it: at the end of a step's text, or after a question's brackets. */
const REQUIRED = /(?:^|\s+)\(required\)$/;
const WHO = /\s+@(\S+)$/;
const BRACKETS = /\s*\[([^\]]*)\]$/;

/** What the step's `text` can't be, if anything. */
const textProblem = (text: string, what: string) => (text === '' ? `the ${what} has no text` : text.length > MAX_STEP_TEXT ? `the ${what} is over ${MAX_STEP_TEXT} characters` : undefined);

/** What is wrong with one step as given, if anything; set-wide limits are `stepsProblem`'s. */
function stepProblem(step: Pick<ParsedStep, 'kind' | 'text' | 'choices' | 'link' | 'section'> & { who: unknown }): string | undefined {
  const problem = textProblem(step.text, 'step') ?? (step.section === null ? undefined : textProblem(step.section, 'section heading'));
  if (problem !== undefined) return problem;
  if (step.link !== null && (step.link === '' || step.link.length > MAX_STEP_TEXT)) return `a link is 1 to ${MAX_STEP_TEXT} characters`;
  if (step.kind !== 'todo' && (step.who !== null || step.link !== null)) return 'only a to-do names who does it, or links to anything';
  const offers = step.kind === 'one' || step.kind === 'any' || step.kind === 'order';
  if (!offers) return step.choices.length === 0 ? undefined : 'only a question has choices';
  if (step.choices.length < MIN_STEP_CHOICES) return `a question with choices needs at least ${MIN_STEP_CHOICES}`;
  const most = step.kind === 'order' ? MAX_STEP_RANKED : MAX_STEP_CHOICES;
  if (step.choices.length > most) return step.kind === 'order' ? `at most ${MAX_STEP_RANKED} rows to put in order` : `at most ${MAX_STEP_CHOICES} choices`;
  for (const [at, choice] of step.choices.entries()) {
    const wrong = textProblem(choice, 'choice');
    if (wrong !== undefined) return wrong;
    if (/[|\]]/.test(choice)) return `a choice can't hold "|" or "]": "${choice}"`;
    if (step.choices.indexOf(choice) !== at) return `"${choice}" is offered twice`;
  }
  return undefined;
}

/** What is wrong with a set of steps, if anything: each step, then how many there are. */
export function stepsProblem(steps: readonly (Pick<ParsedStep, 'kind' | 'text' | 'choices' | 'link' | 'section'> & { who: unknown })[]): string | undefined {
  for (const [at, step] of steps.entries()) {
    const problem = stepProblem(step);
    if (problem !== undefined) return `step ${at + 1}: ${problem}`;
  }
  if (steps.length > MAX_STEPS) return `a steps card holds at most ${MAX_STEPS} steps`;
  if (steps.filter((step) => step.kind !== 'todo').length > MAX_STEPS_QUESTIONS) return `a set asks at most ${MAX_STEPS_QUESTIONS} questions`;
  return undefined;
}

/** `body` without the `(required)` it ends with, and whether it had one. */
function required(body: string): { body: string; required: boolean } {
  const marked = REQUIRED.test(body);
  return { body: marked ? body.replace(REQUIRED, '').trim() : body, required: marked };
}

/** A question's text, kind, choices and `(required)`, from what follows its `?`: `text [choices] (required)`. */
function question(after: string): Pick<ParsedStep, 'kind' | 'text' | 'choices' | 'required'> {
  const last = required(after);
  const brackets = BRACKETS.exec(last.body);
  if (brackets === null) return { kind: 'words', text: last.body, choices: [], required: last.required };
  // `(required)` may come before the brackets too.
  const { body: text, required: before } = required(last.body.slice(0, brackets.index).trim());
  const marked = last.required || before;
  const inside = brackets[1]!.trim();
  if (/^yes\s*\/\s*no$/i.test(inside)) return { kind: 'yes-no', text, choices: [], required: marked };
  const kind = /^any:/i.test(inside) ? 'any' : /^order:/i.test(inside) ? 'order' : 'one';
  const listed = kind === 'one' ? inside : inside.slice(inside.indexOf(':') + 1);
  return { kind, text, choices: listed.split('|').map((choice) => choice.trim()), required: marked };
}

/** A to-do's text, `(required)`, who does it and its link, from what follows its checkbox: `text (required) @who -> link`. */
function todo(after: string): Pick<ParsedStep, 'text' | 'required' | 'who' | 'link'> {
  const last = required(after);
  const arrow = last.body.lastIndexOf(' -> ');
  const link = arrow < 0 ? null : last.body.slice(arrow + 4).trim();
  const rest = arrow < 0 ? last.body : last.body.slice(0, arrow).trim();
  const who = WHO.exec(rest);
  const { body: text, required: marked } = required((who === null ? rest : rest.slice(0, who.index)).trim());
  return { text, required: last.required || marked, who: who?.[1] ?? null, link };
}

/**
 * The title and steps `text` holds, one a line. Throws `StepsFormatError` naming the first line it can't read, and for
 * a set past its limits.
 */
export function parseSteps(text: string): { title: string | null; steps: ParsedStep[] } {
  let title: string | null = null;
  let section: string | null = null;
  const steps: ParsedStep[] = [];
  for (const [at, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const fail = (problem: string) => new StepsFormatError(`line ${at + 1}: ${problem}`);
    if (line === '') continue;
    if (/^#(?:\s|$)/.test(line)) {
      if (title !== null) throw fail('only one "# title" goes in a set');
      title = line.slice(1).trim();
      if (title === '') throw fail('the title has no text');
      if (title.length > MAX_PLAN_TITLE_LENGTH) throw fail(`the title is over ${MAX_PLAN_TITLE_LENGTH} characters`);
      continue;
    }
    if (/^##(?:\s|$)/.test(line)) {
      section = line.slice(2).trim();
      if (section === '') throw fail('the section heading has no text');
      continue;
    }
    const bulleted = BULLET.exec(line);
    const unbulleted = bulleted === null ? line : line.slice(bulleted[0].length);
    const box = bulleted === null ? null : CHECKBOX.exec(unbulleted);
    let parsed: ParsedStep;
    if (box === null && unbulleted.startsWith('?')) {
      parsed = { ...question(unbulleted.slice(1).trim()), section, who: null, link: null, done: false };
    } else if (bulleted !== null) {
      const after = box === null ? unbulleted : unbulleted.slice(box[0].length).trim();
      parsed = { kind: 'todo', ...todo(after), section, choices: [], done: box !== null && /x/i.test(box[1]!) };
    } else {
      throw new StepsFormatError(`line ${at + 1} isn't a step: start a to-do with "- [ ]" or a question with "?"`);
    }
    const problem = stepProblem(parsed);
    if (problem !== undefined) throw fail(problem);
    steps.push(parsed);
  }
  if (steps.length === 0) throw new StepsFormatError('no steps: write one a line, a to-do as "- [ ] text" or a question as "? text"');
  const problem = stepsProblem(steps);
  if (problem !== undefined) throw new StepsFormatError(problem);
  return { title, steps };
}

/** The step as its line in the format, its `@who` written by `name`. */
export function stepLine(step: Step, name: (who: StepsWho) => string): string {
  const required = step.required ? ' (required)' : '';
  if (step.kind === 'todo') {
    const who = step.who === null ? '' : ` @${name(step.who)}`;
    const link = step.link === null ? '' : ` -> ${step.link}`;
    return `- [${step.done === null ? ' ' : 'x'}] ${step.text}${required}${who}${link}`;
  }
  const choices = step.choices.join(' | ');
  const brackets = { one: ` [${choices}]`, any: ` [any: ${choices}]`, order: ` [order: ${choices}]`, 'yes-no': ' [yes/no]', words: '' }[step.kind];
  return `? ${step.text}${brackets}${required}`;
}

/** The answer in words, as the agent is told it and the card shows it. */
export function answerWords(step: Pick<Step, 'kind' | 'choices'>, answer: StepAnswer): string {
  if ('one' in answer) return step.choices[answer.one]!;
  if ('any' in answer) return answer.any.length === 0 ? '(none picked)' : answer.any.map((index) => step.choices[index]!).join(', ');
  if ('yes' in answer) return answer.yes ? 'Yes' : 'No';
  if ('order' in answer) return answer.order.map((index, at) => `${at + 1}. ${step.choices[index]!}`).join('  ');
  return answer.words;
}
