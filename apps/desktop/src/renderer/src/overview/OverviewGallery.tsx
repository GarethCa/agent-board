import { ZONE_COLORS, type Agent, type Zone } from '@agent-board/daemon/protocol';
import { OverviewView } from './OverviewWindow';

/** The gallery's times, as local clock times, so its shot reads the same in any time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const NOW = new Date(2026, 10, 12, 8, 0);
const SEEN = at(11, 18, 40);

const BASE: Omit<Agent, 'sessionId' | 'name' | 'zoneId'> = {
  harness: 'claude',
  state: 'idle',
  stateSince: at(12, 6, 30),
  endedAt: null,
  exitCode: null,
  permissions: [],
  ask: null,
  plan: null,
  stepsWait: null,
  flag: null,
  ledBy: null,
  reviewOf: null,
  master: false,
  status: null,
  lastMessage: null,
  pullRequests: [],
  hibernated: null,
  workFinishedAt: null,
  workCategory: null,
} as unknown as Omit<Agent, 'sessionId' | 'name' | 'zoneId'>;

let next = 0;
const agent = (zoneId: string | null, name: string, patch: Partial<Agent>): Agent => ({ ...BASE, sessionId: `gallery-${++next}`, zoneId, name, ...patch }) as Agent;
const summary = (text: string, updatedAt: string): Agent['status'] => ({ summary: text, progress: null, updatedAt, setBy: null }) as Agent['status'];
const own = (category: NonNullable<Agent['workCategory']>['category'], setAt: string, extra: Partial<NonNullable<Agent['workCategory']>> = {}): Agent['workCategory'] => ({
  category,
  label: null,
  waitingOn: null,
  setAt,
  setBy: null,
  ...extra,
});
const pr = (number: number, state: 'open' | 'merged' | 'draft', checks: 'passing' | 'pending' | 'failing' = 'passing') =>
  ({ number, title: 'Change', url: '', state, checks }) as Agent['pullRequests'][number];

const zone = (id: string, name: string, color: string, x: number): Zone => ({ id, name, color, x, y: 0 }) as Zone;

const ZONES: Zone[] = [zone('pay', 'Payments', ZONE_COLORS[8]!, 0), zone('web', 'Storefront', ZONE_COLORS[0]!, 900), zone('data', 'Data', ZONE_COLORS[1]!, 1800)];

const AGENTS: Agent[] = [
  agent('pay', 'refund-flow', { ask: { id: 'q', askedAt: at(12, 7, 12) } as Agent['ask'], status: summary('Which refund window: 14 or 30 days?', at(12, 7, 12)) }),
  agent('pay', 'payout-report', { pullRequests: [pr(231, 'open')], lastMessage: 'PR #231 is up for review.' }),
  agent('pay', 'card-vault', {
    workCategory: own('waiting-on-others', at(8, 10, 0), { waitingOn: { who: 'Security team', ref: 'scope sign-off' } }),
    status: summary('Scope doc drafted', at(8, 10, 0)),
    stateSince: at(8, 10, 0),
  }),
  agent('pay', 'ledger-sync', { state: 'running', status: summary('Backfilling March', at(12, 7, 40)) }),
  agent('pay', 'tax-rates', { pullRequests: [pr(229, 'merged')], stateSince: at(12, 2, 0) }),
  agent('pay', 'fx-cache', { pullRequests: [pr(224, 'merged')], stateSince: at(11, 15, 0) }),
  agent('web', 'checkout-a11y', { pullRequests: [pr(97, 'open', 'failing')], lastMessage: 'Two contrast checks fail on the dark theme.' }),
  agent('web', 'gift-cards', {
    workCategory: own('waiting-on-others', at(11, 16, 20), { label: 'With Legal', waitingOn: { who: 'Legal', ref: null } }),
    status: summary('Terms copy ready', at(11, 16, 20)),
  }),
  agent('web', 'search-ranking', { state: 'running', status: summary('Tuning the boost for in-stock items', at(12, 7, 55)) }),
  agent('web', 'apple-pay', { state: 'running', status: summary('Apple Pay sheet on Safari', at(12, 7, 50)) }),
  agent('data', 'nightly-export', { state: 'rate-limited', stateSince: at(12, 5, 10) }),
  agent('data', 'churn-model', { pullRequests: [pr(58, 'open', 'pending')], status: summary('Training run 3 of 4', at(12, 6, 0)) }),
  agent('data', 'event-schema', { sessionId: 'gallery-schema', pullRequests: [pr(61, 'open')], status: summary('Schema v2 with the new fields', at(12, 5, 45)) }),
  agent('data', 'schema-review', { state: 'running', reviewOf: 'gallery-schema' }),
  agent(null, 'scratch', { state: 'running', status: summary('Trying a faster CSV parser', at(12, 7, 30)) }),
];

/** The Overview at eight in the morning: three projects and a loose agent, every category among them. */
export function OverviewGallery() {
  return (
    <div className="overview-gallery" data-testid="overview-gallery">
      <OverviewView agents={AGENTS} zones={ZONES} shows="explicit" seenAt={SEEN} now={NOW} onMarkSeen={() => {}} />
    </div>
  );
}
