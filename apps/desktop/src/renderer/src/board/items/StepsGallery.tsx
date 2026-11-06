import type { Step, StepsData, StepsWho } from '@agent-board/daemon/protocol';
import { StepsCard, type StepsCardActions } from './StepsCard';
import type { StepsLookup, ZoomLook } from './steps-view';

const AT = '2026-01-01T00:00:00.000Z';
const USER: StepsWho = { kind: 'user' };
const agent = (name: string): StepsWho => ({ kind: 'agent', sessionId: `gallery-${name}`, name });
const done = { by: USER, at: AT };

let next = 0;
const step = (part: Partial<Step> & Pick<Step, 'text'>): Step => ({
  id: `g${next++}`,
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

const card = (title: string, steps: Step[], part: Partial<StepsData> = {}): StepsData => ({ title, madeBy: agent('lead'), answeredBy: USER, steps, sent: null, waits: [], closedAt: null, ...part });

const merge = step({ text: 'Merge #214', link: 'PR #214' });
const RUNBOOK = card('Release 0.7', [
  step({ text: 'Freeze main', who: agent('lead'), done: { by: agent('lead'), at: AT } }),
  step({ text: 'Changelog', who: agent('impl-3'), done: { by: agent('impl-3'), at: AT } }),
  step({ kind: 'one', text: 'Patch or minor?', who: null, choices: ['patch', 'minor'], answer: { value: { one: 1 }, by: USER, at: AT } }),
  merge,
  step({ text: 'Tag v0.7.0', who: agent('impl-3') }),
  step({ text: 'Post the notes', who: agent('lead') }),
], { waits: [{ sessionId: 'gallery-impl-3', stepId: merge.id }] });

const CALM = card('Release 0.7', RUNBOOK.steps.map((each) => (each === merge ? { ...each, done } : each)), { waits: [] });

const QUESTIONS = card('Cache plan', [
  step({ kind: 'yes-no', text: 'Ship on Friday?', who: null, required: true, answer: { value: { yes: true }, by: USER, at: AT } }),
  step({ kind: 'one', text: 'Which store should the job cache use?', who: null, choices: ['Redis', 'SQLite', 'In memory'] }),
  step({ kind: 'order', text: 'Rank the risks', who: null, choices: ['Data loss', 'Downtime', 'Cost'] }),
  step({ kind: 'words', text: 'Anything else we should know?', who: null }),
]);

const section = (title: string, count: number, doneCount: number, who: StepsWho = agent('impl-3')) =>
  Array.from({ length: count }, (_, at) => step({ text: `${title} step ${at + 1}`, section: title, who, done: at < doneCount ? done : null }));
const LONG = card('Release 0.7 runbook', [
  ...section('Prepare', 8, 8),
  ...section('Build', 10, 10),
  ...section('Release', 2, 2),
  step({ text: 'Merge #214', section: 'Release' }),
  ...section('Release', 6, 0).map((each, at) => ({ ...each, text: ['Tag v0.7.0', 'Publish the build', 'Check the download page', 'Announce it', 'Watch the error rate', 'Close the milestone'][at]! })),
  ...section('After', 7, 0, agent('lead')),
]);

const FINISHED = card('Weekly setup', [step({ text: 'Pull main', done }), step({ text: 'Water the plants', done })], { madeBy: USER });

const LOOKUP: StepsLookup = { live: () => true, name: (sessionId) => sessionId.replace(/^gallery-/, '') };
const ACTIONS: StepsCardActions = { answer: () => {}, tick: () => {}, send: () => {}, stepIn: () => {}, leave: () => {} };

/** Each look of a steps card, by the name its screenshot gives it. */
const CARDS: { name: string; data: StepsData; look: ZoomLook; selected?: boolean; writing?: boolean }[] = [
  { name: 'Yours, at rest', data: RUNBOOK, look: 'full' },
  { name: 'Someone else’s, at rest', data: CALM, look: 'full' },
  { name: 'Selected: the step open', data: RUNBOOK, look: 'full', selected: true },
  { name: 'Questions to answer', data: QUESTIONS, look: 'full', selected: true },
  { name: 'A long list, in sections', data: LONG, look: 'full', selected: true },
  { name: 'An empty card of yours', data: card('New steps', [], { madeBy: USER }), look: 'full', writing: true },
  { name: 'About half size', data: LONG, look: 'mid' },
  { name: 'Far out, yours', data: LONG, look: 'icon' },
  { name: 'Far out, finished', data: FINISHED, look: 'icon' },
];

/** Every look of a steps card, from data alone: for the visual shots, and to see them all at once. */
export function StepsGallery() {
  return (
    <section className="gallery-steps" data-testid="steps-gallery">
      {CARDS.map(({ name, data, look, selected = false, writing = false }) => (
        <figure key={name} className="gallery-steps-cell">
          <div className="gallery-steps-card" data-look={look}>
            <StepsCard data={data} lookup={LOOKUP} look={look} selected={selected} steppedIn={false} writing={writing} actions={ACTIONS} />
          </div>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </section>
  );
}
