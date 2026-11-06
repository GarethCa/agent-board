import { describe, expect, it } from 'vitest';
import type { Step, StepsData, StepsWho } from '@agent-board/daemon/protocol';
import { sendsWithWords, stepRows, stepsView, zoomLook, type StepsLookup } from './steps-view';

const USER: StepsWho = { kind: 'user' };
const agent = (name: string): StepsWho => ({ kind: 'agent', sessionId: `s-${name}`, name });
const stamp = (at = '2026-11-04T10:00:00.000Z') => ({ by: USER, at });

let next = 0;
/** A step with the defaults filled in. */
const step = (part: Partial<Step> & Pick<Step, 'text'>): Step => ({
  id: `p${next++}`,
  kind: 'todo',
  section: null,
  required: false,
  choices: [],
  who: USER,
  link: null,
  done: null,
  answer: null,
  ...part,
});

const card = (steps: Step[], part: Partial<StepsData> = {}): StepsData => ({ title: 'Release 0.7', madeBy: agent('lead'), answeredBy: USER, steps, sent: null, waits: [], closedAt: null, ...part });

/** Every agent live, by its name. */
const live: StepsLookup = { live: () => true, name: (sessionId) => sessionId.replace(/^s-/, '') };

describe('a steps card at rest', () => {
  it('counts what is done and picks the step that matters: the user’s first open step, else the one it is on', () => {
    const merge = step({ text: 'Merge #214' });
    const view = stepsView(
      card([step({ text: 'Freeze main', who: agent('lead'), done: stamp() }), step({ text: 'Tag v0.7.0', who: agent('impl-3') }), merge], {
        waits: [{ sessionId: 's-impl-3', stepId: merge.id }],
      }),
      live,
    );
    expect(view).toMatchObject({ done: 1, total: 3, finished: false });
    expect(view.matter).toMatchObject({ place: 3, state: 'yours', note: 'Yours · impl-3 waits' });
    const calm = stepsView(card([step({ text: 'Freeze main', done: stamp() }), step({ text: 'Tag v0.7.0', who: agent('impl-3') })]), live);
    expect(calm.matter).toMatchObject({ place: 2, state: 'now', note: 'impl-3' });
  });

  it('makes an unanswered question the user’s, unless an orchestrator answers the set while it is live', () => {
    const steps = [step({ kind: 'one', text: 'Patch or minor?', who: null, choices: ['patch', 'minor'] })];
    expect(stepsView(card(steps), live).matter).toMatchObject({ state: 'yours', note: 'Yours to answer' });
    const crew = stepsView(card(steps, { answeredBy: agent('lead') }), live);
    expect(crew).toMatchObject({ userAnswers: false, answerer: 'lead' });
    expect(crew.matter).toMatchObject({ state: 'now', note: 'lead answers' });
    expect(stepsView(card(steps, { answeredBy: agent('lead') }), { ...live, live: () => false }).userAnswers).toBe(true);
  });

  it('splits the bar by section, and says when a list is finished', () => {
    const view = stepsView(
      card([
        step({ text: 'a', section: 'Prepare', done: stamp() }),
        step({ text: 'b', section: 'Prepare', done: stamp() }),
        step({ text: 'c', section: 'Release', done: stamp() }),
        step({ text: 'd', section: 'Release' }),
      ]),
      live,
    );
    expect(view.sections.map(({ title, done, total }) => [title, done, total])).toEqual([
      ['Prepare', 2, 2],
      ['Release', 1, 2],
    ]);
    expect(stepsView(card([step({ text: 'a', done: stamp() })]), live)).toMatchObject({ finished: true, matter: null });
  });

  it('can send once every required question is answered, and says when the answers sent are the latest', () => {
    const ask = step({ kind: 'yes-no', text: 'Ship it?', who: null, required: true });
    expect(stepsView(card([ask]), live).send).toEqual({ kind: 'blocked', place: 1 });
    const answered = { ...ask, answer: { value: { yes: true }, by: USER, at: '2026-11-04T10:00:00.000Z' } };
    expect(stepsView(card([answered]), live).send).toEqual({ kind: 'ready' });
    expect(stepsView(card([answered], { sent: { at: '2026-11-04T10:01:00.000Z', answers: {} } }), live).send).toEqual({ kind: 'sent' });
    expect(stepsView(card([answered], { sent: { at: '2026-11-04T09:00:00.000Z', answers: {} } }), live).send).toEqual({ kind: 'ready' });
    expect(stepsView(card([answered], { madeBy: USER }), live).send).toEqual({ kind: 'none' });
    expect(stepsView(card([step({ text: 'only to-dos' })]), live).send).toEqual({ kind: 'none' });
  });
});

describe('a steps card selected', () => {
  const twelve = Array.from({ length: 12 }, (_, at) => step({ text: `Step ${at + 1}`, done: at < 5 ? stamp() : null }));

  it('with no headings: the steps before folded but the last, the step that matters, the next three, and how many more', () => {
    const view = stepsView(card(twelve), live);
    const rows = stepRows(view, view.matter!.step.id, new Set());
    expect(rows.map((row) => (row.kind === 'step' ? `${row.view.step.text}${row.open ? ' (open)' : ''}` : `${row.kind}: ${row.label}`))).toEqual([
      'folded: 4 earlier',
      'Step 5',
      'Step 6 (open)',
      'Step 7',
      'Step 8',
      'Step 9',
      'more: 3 more',
    ]);
    // Opened, each fold shows what it held.
    expect(stepRows(view, view.matter!.step.id, new Set(['done:', 'more:'])).filter((row) => row.kind === 'step')).toHaveLength(12);
  });

  it('with headings: finished sections folded, the one it is in open around the step, later ones folded with counts', () => {
    const steps = [
      step({ text: 'Freeze', section: 'Prepare', done: stamp() }),
      step({ text: 'Smoke-test', section: 'Release', done: stamp() }),
      step({ text: 'Merge #214', section: 'Release' }),
      step({ text: 'Tag', section: 'Release' }),
      step({ text: 'Post notes', section: 'After' }),
    ];
    const view = stepsView(card(steps), live);
    const rows = stepRows(view, view.matter!.step.id, new Set());
    expect(rows.map((row) => (row.kind === 'step' ? row.view.step.text : `${row.kind}: ${row.label} ${row.count ?? ''}`.trim()))).toEqual([
      'section: Prepare 1/1',
      'section: Release 1/3',
      'Smoke-test',
      'Merge #214',
      'Tag',
      'section: After 0/1',
    ]);
    expect(rows.find((row) => row.kind === 'section' && row.label === 'Prepare')).toMatchObject({ open: false, finished: true });
    expect(rows.find((row) => row.kind === 'section' && row.label === 'Release')).toMatchObject({ open: true });
  });

  it('opens the step the cursor is on, which may be a done one to change', () => {
    const view = stepsView(card(twelve), live);
    const rows = stepRows(view, twelve[1]!.id, new Set());
    expect(rows.find((row) => row.kind === 'step' && row.open)).toMatchObject({ view: { step: { text: 'Step 2' } } });
  });
});

describe('how far out a steps card is drawn', () => {
  it('in full, in larger type with fewer lines, or as its icon tile', () => {
    expect([1, 0.7, 0.55, 0.45, 0.3].map((zoom) => zoomLook(zoom, false))).toEqual(['full', 'full', 'mid', 'mid', 'icon']);
    expect(zoomLook(1, true)).toBe('icon');
  });
});

describe('⌘↵ in a words answer', () => {
  it('sends only when Send is ready once its words are saved', () => {
    const words = step({ kind: 'words', text: 'Anything else?', who: null, required: true });
    const other = step({ kind: 'yes-no', text: 'Ship on Friday?', who: null, required: true });
    // Its words are all the card waits on: they make it ready.
    expect(sendsWithWords(card([words]), live, words.id, 'Ship it')).toBe(true);
    // Still blocked: no words, or another required step unanswered.
    expect(sendsWithWords(card([words]), live, words.id, '')).toBe(false);
    expect(sendsWithWords(card([words, other]), live, words.id, 'Ship it')).toBe(false);
    // Sent, the same words change nothing; new ones send again.
    const answered = { ...words, answer: { value: { words: 'Ship it' }, ...stamp() } };
    const sent = card([answered], { sent: { at: '2026-11-04T11:00:00.000Z', answers: {} } });
    expect(sendsWithWords(sent, live, words.id, 'Ship it')).toBe(false);
    expect(sendsWithWords(sent, live, words.id, 'Hold it')).toBe(true);
  });
});
