import { crewCardSize, type Agent, type AgentState, type Crew, type CrewCardData, type CrewCardMember, type CrewReviewer } from '@agent-board/daemon/protocol';
import { useTechnicalDetails } from '../../technical';
import { galleryAgent } from '../TileGallery';
import { CrewCardView } from './CrewCard';
import { crewCardModel } from './crew-card';

const member = (id: string, name: string, role: string, fields: Partial<CrewCardMember> = {}): CrewCardMember => ({ id, name, role, harness: 'claude', model: null, starts: 'handoff', ...fields });
const BUILDER = member('builder', 'Builder', 'implementer', { starts: 'prompt' });
const TRIO = [BUILDER, member('code-review', 'Code review', 'reviewer'), member('design-review', 'Design review', 'designer')];
const PAIR = [BUILDER, member('review', 'Review', 'reviewer')];
const MANY = [BUILDER, ...['Security', 'Tests', 'A11y', 'Performance', 'Docs', 'API', 'Copy', 'Design', 'Privacy'].map((name) => member(name.toLowerCase(), name, 'reviewer'))];

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({ ...galleryAgent(state), sessionId, name: sessionId, status: null, pullRequests: [], ...fields });
const doing = (summary: string) => ({ status: { summary } as Agent['status'] });
const reviewer = (key: string, round: number, fields: Partial<CrewReviewer> = {}): CrewReviewer => ({ member: key, sessionId: `${key}-${round}`, name: `${key} (round ${round})`, round, verdict: null, blockers: null, ...fields });
const approved = { verdict: 'approve', blockers: 0 } as const;
const changes = (blockers: number) => ({ verdict: 'changes-requested', blockers }) as const;
const asks = (question: string): Agent['ask'] => ({ id: 'a', question, options: [], freeText: true, askedAt: at(10, 30), expiresAt: at(11, 30), onBoard: false, questions: [{ question, options: [], freeText: true }], answers: [null], card: null });
const PR = { number: 231, title: 'Fix the login redirect after SSO', url: '', state: 'open', checks: 'passing' } as Agent['pullRequests'][number];

/** The gallery's clock: fixed, so its times read the same in every run. */
const at = (hour: number, minute: number) => new Date(2026, 10, 5, hour, minute).toISOString();

function card(title: string, crew: Partial<Crew>, fields: Partial<CrewCardData> = {}): CrewCardData {
  return {
    crewId: 'gallery',
    title,
    icon: 'crew',
    tiles: false,
    members: TRIO,
    crew: { id: 'gallery', prefab: 'Trio', zoneId: 'gallery', startedBy: null, builder: 'b', round: 1, roundLimit: 3, phase: 'building', needsYou: false, stopped: null, startedAt: at(10, 0), stoppedAt: null, reviewers: [], ...crew },
    phaseAt: at(10, 22),
    startFailed: false,
    startError: null,
    ...fields,
  };
}

const LOGIN = 'Fix the login redirect after SSO';
const ROUND_1 = [reviewer('code-review', 1, changes(3)), reviewer('design-review', 1, approved)];
const ROUND_2 = [reviewer('code-review', 2, approved), reviewer('design-review', 2, approved)];
const ROUND_3 = [reviewer('code-review', 3, changes(1)), reviewer('design-review', 3, approved)];

const AT_LIMIT = card(LOGIN, { round: 3, phase: 'stopped', stopped: 'round-limit', reviewers: [...ROUND_1, ...ROUND_3] });
const LIMIT_AGENTS = [agent('b', 'idle', { pullRequests: [PR] }), agent('code-review-3', 'idle'), agent('design-review-3', 'idle')];

/** A look of the card: what the daemon wrote of its crew, and its agents as they are. */
interface Look {
  id: string;
  data: CrewCardData;
  agents: Agent[];
  busy?: 'round';
}

const LOOKS: Look[][] = [
  [
    { id: 'started', data: card('Add a footer to the settings page', { prefab: 'Implementer + reviewer' }, { members: PAIR, phaseAt: at(10, 0) }), agents: [agent('b', 'running', doing('reading the settings page'))] },
    {
      id: 'reviewing',
      data: card(LOGIN, { phase: 'reviewing', reviewers: [reviewer('code-review', 1), reviewer('design-review', 1)] }, { phaseAt: at(10, 14) }),
      agents: [agent('b', 'idle', { pullRequests: [PR] }), agent('code-review-1', 'running', doing('reading the diff')), agent('design-review-1', 'thinking')],
    },
    { id: 'fixing', data: card(LOGIN, { round: 2, reviewers: ROUND_1 }), agents: [agent('b', 'running', { ...doing('fixing 3 findings'), pullRequests: [PR] })] },
  ],
  [
    {
      id: 'asks',
      data: card(LOGIN, { round: 2, reviewers: ROUND_1 }),
      agents: [agent('b', 'waiting', { ask: asks('Keep the old ?next= param for one release, or drop it?'), pullRequests: [PR] })],
    },
    {
      id: 'start-failed',
      data: card(LOGIN, { round: 2, reviewers: ROUND_1 }, { startFailed: true, startError: 'The crew’s zone has no room for another agent.' }),
      agents: [agent('b', 'idle', { pullRequests: [PR] })],
    },
    { id: 'ready', data: card(LOGIN, { round: 2, phase: 'stopped', stopped: 'ready-to-merge', reviewers: [...ROUND_1, ...ROUND_2] }), agents: [agent('b', 'idle', { pullRequests: [PR] }), agent('code-review-2', 'idle'), agent('design-review-2', 'idle')] },
  ],
  [
    {
      id: 'ready-failing',
      data: card(LOGIN, { round: 2, phase: 'stopped', stopped: 'ready-to-merge', reviewers: [...ROUND_1, ...ROUND_2] }),
      agents: [agent('b', 'idle', { pullRequests: [{ ...PR, checks: 'failing' }] }), agent('code-review-2', 'idle'), agent('design-review-2', 'idle')],
    },
    { id: 'limit', data: AT_LIMIT, agents: LIMIT_AGENTS },
    { id: 'limit-asked', data: AT_LIMIT, agents: LIMIT_AGENTS, busy: 'round' },
  ],
  [
    { id: 'merged', data: card(LOGIN, { round: 2, phase: 'stopped', stopped: 'merged', reviewers: [...ROUND_1, ...ROUND_2] }), agents: [] },
    { id: 'stopped', data: card(LOGIN, { round: 2, phase: 'stopped', stopped: 'stopped', reviewers: ROUND_1 }), agents: [agent('b', 'idle', { pullRequests: [PR] })] },
    { id: 'builder-gone', data: card(LOGIN, { round: 1, phase: 'stopped', stopped: 'builder-gone' }, { members: PAIR }), agents: [] },
  ],
  [
    {
      id: 'many',
      data: card('Audit the checkout flow before the release, every page of it', { phase: 'reviewing', roundLimit: 10, round: 4, reviewers: MANY.slice(1).map((each) => reviewer(each.id, 4)) }, { members: MANY }),
      agents: [agent('b', 'idle'), ...MANY.slice(1).map((each, index) => agent(`${each.id}-4`, index % 3 === 0 ? 'thinking' : 'running'))],
    },
  ],
];

const noop = () => {};

/**
 * A crew card in each of its looks: just started, its reviewers at work, its builder fixing what they found; a member
 * asking the user, a round that could not start with why, and ready to merge; ready to merge with its pull request's
 * checks failing, at its round limit, and there with one more round asked for; merged, stopped and its builder gone; and
 * a crew of ten. Its rows read agents as the window's design does: by status under Simplified, by state under Classic.
 */
export function CrewCardGallery() {
  const technical = useTechnicalDetails();
  return (
    <section className="listcard-gallery" data-testid="crew-card-gallery" aria-label="Crew card">
      {LOOKS.map((row, index) => (
        <div key={index} className="listcard-gallery-row">
          {row.map(({ id, data, agents, busy }) => (
            <div key={id} style={crewCardSize(data.members.length)} data-testid={`crew-card-gallery-${id}`}>
              <CrewCardView title={data.title} icon={data.icon} model={crewCardModel(data, agents, 'explicit', !technical)} busy={busy} onAction={noop} onOpenAgent={noop} onOpenPullRequest={noop} />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
