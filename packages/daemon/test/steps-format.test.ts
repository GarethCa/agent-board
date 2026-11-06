import { describe, expect, it } from 'vitest';
import { parseSteps, stepLine, stepsProblem, type ParsedStep } from '../src/steps-format.ts';
import { MAX_STEP_CHOICES, MAX_STEP_RANKED, MAX_STEPS, MAX_STEPS_QUESTIONS, type Step } from '../src/protocol.ts';

/** A parsed step with the defaults filled in, for comparing. */
const step = (part: Partial<ParsedStep> & Pick<ParsedStep, 'kind' | 'text'>): ParsedStep => ({
  section: null,
  required: false,
  choices: [],
  who: null,
  link: null,
  done: false,
  ...part,
});

describe('the steps line format', () => {
  it('reads to-dos: ticked or not, who does each, and a link', () => {
    const parsed = parseSteps('- [ ] Merge the flake fix @impl -> https://example.test/pr/12\n- [x] Pin node 22\n- [ ] Rotate the key @user (required)');
    expect(parsed).toEqual({
      title: null,
      steps: [
        step({ kind: 'todo', text: 'Merge the flake fix', who: 'impl', link: 'https://example.test/pr/12' }),
        step({ kind: 'todo', text: 'Pin node 22', done: true }),
        step({ kind: 'todo', text: 'Rotate the key', who: 'user', required: true }),
      ],
    });
  });

  it('reads each kind of question, and which are required', () => {
    const { steps } = parseSteps(
      [
        '? Which database? [Postgres | SQLite] (required)',
        '? Which checks run on a PR? [any: lint | unit | e2e]',
        '? Ship on Friday? [yes/no]',
        '? Rank the risks [order: data loss | downtime | cost]',
        '? Anything else we should know?',
      ].join('\n'),
    );
    expect(steps).toEqual([
      step({ kind: 'one', text: 'Which database?', choices: ['Postgres', 'SQLite'], required: true }),
      step({ kind: 'any', text: 'Which checks run on a PR?', choices: ['lint', 'unit', 'e2e'] }),
      step({ kind: 'yes-no', text: 'Ship on Friday?' }),
      step({ kind: 'order', text: 'Rank the risks', choices: ['data loss', 'downtime', 'cost'] }),
      step({ kind: 'words', text: 'Anything else we should know?' }),
    ]);
  });

  it('takes a `# title`, `## sections`, and skips blank lines', () => {
    const parsed = parseSteps('# Weekly setup\n\n## Before\n- [ ] Pull main\n\n## After\n? All green? [yes/no]\n');
    expect(parsed.title).toBe('Weekly setup');
    expect(parsed.steps.map((each) => [each.section, each.text])).toEqual([
      ['Before', 'Pull main'],
      ['After', 'All green?'],
    ]);
  });

  it('reads a pasted bulleted or numbered list as to-dos, and a numbered question as a question', () => {
    const { steps } = parseSteps('1. Pull main\n2) Run the gate\n* Tag it\n3. ? Ship it? [yes/no]');
    expect(steps.map((each) => [each.kind, each.text])).toEqual([
      ['todo', 'Pull main'],
      ['todo', 'Run the gate'],
      ['todo', 'Tag it'],
      ['yes-no', 'Ship it?'],
    ]);
  });

  it('keeps `@`, `->` and brackets inside the text when they are not where the format puts them', () => {
    const { steps } = parseSteps('- [ ] Mail ops@example.test about a -> b moves\n? Is [draft] still right?');
    expect(steps[0]).toEqual(step({ kind: 'todo', text: 'Mail ops@example.test about a', link: 'b moves' }));
    expect(steps[1]).toEqual(step({ kind: 'words', text: 'Is [draft] still right?' }));
  });

  it('says which line it can’t read, and why', () => {
    expect(() => parseSteps('- [ ] Fine\nJust words')).toThrow(/line 2 isn't a step: start a to-do with "- \[ \]" or a question with "\?"/);
    expect(() => parseSteps('? Pick [only one]')).toThrow(/line 1: a question with choices needs at least 2/);
    expect(() => parseSteps('? Pick [a | a]')).toThrow(/line 1: "a" is offered twice/);
    expect(() => parseSteps('- [ ]   ')).toThrow(/line 1: the step has no text/);
    expect(() => parseSteps('# One\n# Two')).toThrow(/line 2: only one "# title"/);
    expect(() => parseSteps('')).toThrow(/no steps/);
  });

  it('reads `(required)` only where the format puts it, and `[]` as an empty checkbox', () => {
    expect(parseSteps('? Do you need (required) docs? [a | b]').steps[0]).toEqual(step({ kind: 'one', text: 'Do you need (required) docs?', choices: ['a', 'b'] }));
    expect(parseSteps('? Which? (required) [a | b]').steps[0]).toEqual(step({ kind: 'one', text: 'Which?', choices: ['a', 'b'], required: true }));
    expect(parseSteps('- [ ] Tag it (required) @impl -> v1.4').steps[0]).toEqual(step({ kind: 'todo', text: 'Tag it', required: true, who: 'impl', link: 'v1.4' }));
    expect(parseSteps('- [] Tidy up').steps[0]).toEqual(step({ kind: 'todo', text: 'Tidy up' }));
  });

  it('refuses an empty title or heading, and a choice that would not read back', () => {
    expect(() => parseSteps('#\n- [ ] x')).toThrow('line 1: the title has no text');
    expect(() => parseSteps('##\n- [ ] x')).toThrow('line 1: the section heading has no text');
    expect(stepsProblem([step({ kind: 'one', text: 'Pick', choices: ['a|b', 'c'] })])).toMatch('step 1: a choice can\'t hold "|" or "]"');
    expect(stepsProblem([step({ kind: 'one', text: 'Pick', choices: ['a]', 'c'] })])).toMatch('a choice can\'t hold');
  });

  it('holds a set to its limits', () => {
    const todos = (count: number) => Array.from({ length: count }, (_, at) => step({ kind: 'todo', text: `Step ${at + 1}` }));
    const questions = (count: number) => Array.from({ length: count }, (_, at) => step({ kind: 'words', text: `Question ${at + 1}` }));
    expect(stepsProblem(todos(MAX_STEPS))).toBeUndefined();
    expect(stepsProblem(todos(MAX_STEPS + 1))).toMatch(`at most ${MAX_STEPS} steps`);
    expect(stepsProblem(questions(MAX_STEPS_QUESTIONS))).toBeUndefined();
    expect(stepsProblem(questions(MAX_STEPS_QUESTIONS + 1))).toMatch(`at most ${MAX_STEPS_QUESTIONS} questions`);
    const choices = (count: number) => Array.from({ length: count }, (_, at) => `c${at}`);
    expect(stepsProblem([step({ kind: 'one', text: 'Pick', choices: choices(MAX_STEP_CHOICES + 1) })])).toMatch(`step 1: at most ${MAX_STEP_CHOICES} choices`);
    expect(stepsProblem([step({ kind: 'order', text: 'Rank', choices: choices(MAX_STEP_RANKED + 1) })])).toMatch(`step 1: at most ${MAX_STEP_RANKED} rows to put in order`);
    expect(stepsProblem([step({ kind: 'todo', text: 'Tick', choices: ['a', 'b'] })])).toMatch('step 1: only a question has choices');
    expect(stepsProblem([step({ kind: 'yes-no', text: 'Ok?', who: 'impl' })])).toMatch('step 1: only a to-do names who does it');
  });

  it('writes a step back as the line it was read from', () => {
    const lines = [
      '- [ ] Merge the flake fix (required) @impl -> https://example.test/pr/12',
      '- [x] Pin node 22',
      '? Which database? [Postgres | SQLite] (required)',
      '? Which checks run? [any: lint | unit]',
      '? Ship on Friday? [yes/no]',
      '? Rank the risks [order: data loss | downtime]',
      '? Anything else?',
    ];
    const { steps } = parseSteps(lines.join('\n'));
    const asStep = (parsed: ParsedStep): Step => ({
      ...parsed,
      id: 'x',
      who: parsed.who === null ? null : { kind: 'agent', sessionId: 's', name: parsed.who },
      done: parsed.done ? { by: { kind: 'user' }, at: '' } : null,
      answer: null,
    });
    expect(steps.map((each) => stepLine(asStep(each), (who) => (who.kind === 'user' ? 'user' : who.name)))).toEqual(lines);
  });
});
