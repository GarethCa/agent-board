import type { Agent, AgentAsk, AgentStepsWait, Step, StepsData, StepsWho } from '@agent-board/daemon/protocol';
import { galleryAgent } from '../board/TileGallery';
import { StepsStepper, type StepsCardActions } from '../board/items/StepsCard';
import type { StepsLookup } from '../board/items/steps-view';
import { Inbox } from './Inbox';
import { GivenStepsCards, StepsWaitBody } from './StepsWaitBody';

/** A time `minutes` before the gallery is drawn, so a row's age always reads the same. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const wait = (kind: 'steps' | 'todo', fields: Partial<AgentStepsWait> = {}): AgentStepsWait => ({
  kind,
  itemId: `gallery-${kind}`,
  title: 'Release 1.4',
  stepId: 's1',
  text: kind === 'steps' ? 'Which database should the job cache use?' : 'Rotate the deploy key',
  open: kind === 'steps' ? 2 : 0,
  since: ago(6),
  ...fields,
});

const QUESTIONS: AgentAsk['questions'] = [
  { question: 'Where should the rate limiter live?', options: ['In the gateway', 'In each service'], freeText: false },
  { question: 'Keep the old limit for internal calls?', options: ['Yes', 'No'], freeText: false },
  { question: 'Anything else I should know?', options: [], freeText: true },
];
const ASK: AgentAsk = { id: 'gallery-ask', question: QUESTIONS[0]!.question, options: QUESTIONS[0]!.options, freeText: false, askedAt: ago(3), expiresAt: ago(-27), onBoard: false, questions: QUESTIONS, answers: [{ option: 0 }, null, null], card: null };

const agent = (sessionId: string, name: string, fields: Partial<Agent>): Agent => ({ ...galleryAgent('idle'), sessionId, name, permissions: [], ask: null, plan: null, flag: null, stepsWait: null, seen: false, ...fields });

/** Needs you with a set to answer, a to-do waited on, and an ask of several questions, as the inbox lists them. */
const AGENTS: Agent[] = [
  agent('gallery-release', 'Cut the release', { stepsWait: wait('steps') }),
  agent('gallery-keys', 'Rotate the keys', { stepsWait: wait('todo', { title: 'Deploy checklist', since: ago(12) }) }),
  agent('gallery-limits', 'Rate limits', { state: 'waiting', ask: ASK }),
];

const USER: StepsWho = { kind: 'user' };
const AT = '2026-01-01T00:00:00.000Z';
const step = (id: string, part: Partial<Step> & Pick<Step, 'text' | 'kind'>): Step => ({ id, section: null, required: false, choices: [], who: null, link: null, done: null, answer: null, ...part });
const SET: StepsData = {
  title: 'Release 1.4',
  madeBy: { kind: 'agent', sessionId: 'gallery-release', name: 'Cut the release' },
  answeredBy: USER,
  steps: [
    step('q1', { kind: 'one', text: 'Which database should the job cache use?', choices: ['Postgres', 'SQLite'], answer: { value: { one: 1 }, by: USER, at: AT } }),
    step('q2', { kind: 'any', text: 'Which regions go first?', choices: ['eu-west', 'us-east', 'ap-south'] }),
    step('q3', { kind: 'yes-no', text: 'Ship on Friday?', required: true }),
  ],
  sent: null,
  waits: [],
  closedAt: null,
};
const LOOKUP: StepsLookup = { live: () => true, name: () => 'Cut the release' };
const ACTIONS: StepsCardActions = { answer: () => {}, tick: () => {}, send: () => {}, stepIn: () => {}, leave: () => {} };

/** A set an agent waits on, in Needs you and above its composer: the rows, the stepper open, and the strip. */
export function NeedsYouStepsGallery() {
  return (
    <section className="gallery-needs-you-steps" data-testid="needs-you-steps-gallery">
      <figure className="gallery-needs-you-steps-cell">
        <div className="gallery-needs-you-steps-inbox">
          <GivenStepsCards.Provider value={{ 'gallery-steps': SET }}>
            <Inbox agents={AGENTS} zones={[]} onOpen={() => {}} heading={false} />
          </GivenStepsCards.Provider>
        </div>
        <figcaption>Needs you: a set to answer, a to-do, and an ask of several questions</figcaption>
      </figure>
      <figure className="gallery-needs-you-steps-cell">
        <div className="gallery-needs-you-steps-stepper">
          <StepsStepper data={SET} lookup={LOOKUP} actions={ACTIONS} />
        </div>
        <figcaption>Answer: its questions stepped through</figcaption>
      </figure>
      <figure className="gallery-needs-you-steps-cell">
        {/* On the window's own surface, the terminal's dark in a light app: the strip keeps the app's colours. */}
        <div className="gallery-needs-you-steps-window">
          <div className="steps-strip">
            <StepsStepper data={SET} lookup={LOOKUP} actions={ACTIONS} />
          </div>
          <div className="steps-strip">
            <StepsWaitBody wait={wait('todo', { title: 'Deploy checklist' })} agents={[]} />
          </div>
        </div>
        <figcaption>Above the composer: a set, open, and a to-do it waits on</figcaption>
      </figure>
    </section>
  );
}
