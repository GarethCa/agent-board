// The agent sidebar's gallery (`#gallery-agent-sidebar`, a page of the dev gallery's own): a busy agent and a quiet one, as the design draws them, with the shelves
// open on the page, the page styled by the agent, the page at the least width, a page of links and a note, and Made,
// Crew and Setup. Fixed data and no daemon, so its
// shots are the same every run.
import type { Agent, AgentPage, AgentRecord, GateRun } from '@agent-board/daemon/protocol';
import { galleryAgent } from '../board/TileGallery';
import { AgentShelves, type ShelfActions } from './AgentShelves';
import type { RecordDeletes } from './RecordList';
import type { ShelfId } from './shelves';

const AT = '2026-01-01T09:14:00.000Z';
const at = (time: string) => `2026-01-01T${time}:00.000Z`;
const WORKTREE = '/worktrees/billing-api/export-invoices-csv';

const record = (fields: Record<string, unknown>): AgentRecord => ({ recordedAt: at('10:05'), deletedAt: null, ...fields }) as AgentRecord;

const PAGE: AgentPage = {
  name: 'Export',
  icon: 'route',
  writtenAt: at('10:40'),
  blocks: [
    { kind: 'heading', title: 'Where I’m up to', icon: 'route', tone: 'neutral', text: 'Streaming rows into the CSV writer. Then the docs, then I hand the pull request to review.', progress: 60 },
    {
      kind: 'figures',
      title: null,
      icon: null,
      tone: 'neutral',
      figures: [
        { value: '214', label: 'tests passing', icon: 'flask-conical', tone: 'green' },
        { value: '18k', label: 'rows a second', icon: 'gauge', tone: 'blue' },
      ],
    },
    {
      kind: 'checklist',
      title: 'The plan',
      icon: 'list-checks',
      tone: 'neutral',
      items: [
        { text: 'Plan approved', state: 'done' },
        { text: 'Stream the writer', state: 'done' },
        { text: 'Export tests', state: 'doing' },
        { text: 'Docs for the export', state: 'todo' },
        { text: 'Pull request green', state: 'todo' },
      ],
    },
    { kind: 'callout', title: null, icon: 'lightbulb', tone: 'neutral', text: 'Invoices from before 2024 have no tax column. The export leaves it blank rather than guessing.' },
  ],
};

/** The same page, styled by the agent: its own icon, and violet and teal blocks. */
const STYLED_PAGE: AgentPage = {
  ...PAGE,
  icon: 'rocket',
  blocks: PAGE.blocks.map((block) =>
    block.kind === 'figures'
      ? { ...block, figures: block.figures.map((figure, index) => ({ ...figure, tone: index === 0 ? 'violet' : 'teal' })) }
      : block.kind === 'callout'
        ? { ...block, tone: 'violet' }
        : block.kind === 'heading'
          ? { ...block, icon: 'rocket', tone: 'teal' }
          : block,
  ),
};

const BUSY_ID = 'gallery-busy';

const crew = (id: string, name: string, role: Agent['role'], overrides: Partial<Agent>): Agent => ({
  ...galleryAgent('running'),
  sessionId: id,
  name,
  role,
  spawnedBy: BUSY_ID,
  lastMessage: null,
  createdAt: AT,
  flag: null,
  ask: null,
  permissions: [],
  pullRequests: [],
  subagents: [],
  ...overrides,
});

const CREW: Agent[] = [
  crew('gallery-review', 'Review: CSV export', 'reviewer', { state: 'needs-permission', permissions: [{ id: 'p', tool: 'Bash', input: {}, at: AT }] as unknown as Agent['permissions'] }),
  crew('gallery-docs', 'Docs: export guide', 'implementer', { state: 'running' }),
  crew('gallery-flaky', 'Fix flaky date test', 'implementer', { state: 'done', endedAt: at('10:30') }),
  crew('gallery-crashed', 'Migrate old exports', 'implementer', { state: 'failed', endedAt: at('10:35'), exitCode: 1 }),
  crew('gallery-paused', 'Tidy the CSV helpers', 'implementer', { state: 'hibernated', endedAt: at('10:36') }),
];

const BUSY: Agent = {
  ...galleryAgent('running'),
  sessionId: BUSY_ID,
  name: 'Export invoices as CSV',
  branch: 'export-invoices-csv',
  ownedBranch: 'export-invoices-csv',
  worktree: WORKTREE,
  cwd: WORKTREE,
  model: 'opus',
  role: null,
  createdAt: AT,
  lastMessage: 'I split the writer into a stream so big exports stay out of memory. Running the export tests next.',
  status: { summary: 'Streaming rows into the CSV writer', progress: 60, updatedAt: at('10:41'), setBy: null },
  issue: { provider: 'linear', id: 'ACME-212', title: 'Export invoices as CSV', url: 'https://linear.app/acme/issue/ACME-212' },
  pullRequests: [
    { number: 482, title: 'Export invoices as CSV', url: 'https://github.com/acme/billing/pull/482', state: 'open', checks: 'pending' },
    { number: 477, title: 'Invoice totals view', url: 'https://github.com/acme/billing/pull/477', state: 'merged', checks: 'passing' },
  ],
  guessedDoc: `${WORKTREE}/.agent-board/handover.md`,
  plan: { id: 'plan', version: 3, title: 'Export invoices as CSV', format: 'markdown', presentedAt: at('09:31'), expiresAt: null, left: false, decision: null, author: 'agent', path: null } as unknown as Agent['plan'],
  docs: [{ id: 'spec', sessionId: BUSY_ID, path: `${WORKTREE}/docs/csv-columns.md`, title: 'CSV column spec', format: 'markdown', version: 2, writtenAt: at('09:48'), writtenBy: 'agent', editable: true, shownAt: at('09:48') }] as unknown as Agent['docs'],
  subagents: [{ id: 'explore', type: 'Explore', state: 'running', startedAt: at('10:38'), endedAt: null, result: null }] as unknown as Agent['subagents'],
  schedule: { clockId: 'clock', cron: '0 9 * * 1-5', prompt: 'Check the nightly export', enabled: true, nextRunAt: '2026-01-02T09:00:00.000Z', lastRun: null } as unknown as Agent['schedule'],
  records: [
    record({ kind: 'pr', key: 'acme/billing#482', url: 'https://github.com/acme/billing/pull/482', title: 'Export invoices as CSV', recordedAt: at('10:20') }),
    ...CREW.map((member) => record({ kind: 'crew', key: member.sessionId })),
    record({ kind: 'doc', key: `${WORKTREE}/review-r1.md`, path: `${WORKTREE}/review-r1.md`, from: { sessionId: 'gallery-review', name: 'Review: CSV export' }, recordedAt: at('10:32') }),
    record({ kind: 'doc', key: `${WORKTREE}/old-notes.md`, path: `${WORKTREE}/old-notes.md`, from: null, deletedAt: at('10:33') }),
    record({ kind: 'pin', key: 'https://localhost:5173/exports', target: { kind: 'link', url: 'http://localhost:5173/exports' }, label: null, from: null }),
    record({ kind: 'pin', key: 'note:Test logins', target: { kind: 'note', text: 'ann, bob and cy · password: demo' }, label: 'Test logins', from: null }),
    record({ kind: 'pin', key: `${WORKTREE}/sample-export.csv`, target: { kind: 'file', path: `${WORKTREE}/sample-export.csv` }, label: null, from: null }),
  ],
  page: PAGE,
};

const QUIET: Agent = {
  ...galleryAgent('waiting'),
  sessionId: 'gallery-quiet',
  name: 'Pick a database',
  branch: 'pick-a-database-80c2e9',
  ownedBranch: 'pick-a-database-80c2e9',
  worktree: '/worktrees/web-app/pick-a-database-80c2e9',
  cwd: '/worktrees/web-app/pick-a-database-80c2e9',
  model: 'sonnet',
  createdAt: AT,
  lastMessage: 'Which database should I use, Postgres or SQLite?',
  issue: null,
  pullRequests: [],
  ask: { id: 'ask', question: 'Which database should I use, Postgres or SQLite?', options: [], at: AT } as unknown as Agent['ask'],
};

const AGENTS = [BUSY, QUIET, ...CREW];

const GATE: GateRun = { sessionId: BUSY_ID, command: 'pnpm check', commit: 'a3f91c2d', dirty: false, startedAt: at('10:10'), endedAt: at('10:14'), status: 'passed', exitCode: 0, steps: ['lint', 'typecheck', 'unit', 'e2e'].map((name) => ({ name, status: 'passed', startedAt: at('10:10'), endedAt: at('10:14') })) };
const FAILED_GATE: GateRun = { ...GATE, status: 'failed', exitCode: 1, steps: [{ name: 'lint', status: 'failed', startedAt: at('10:10'), endedAt: at('10:14') }] };
const NOW = new Date(at('11:00'));
const NO_RECORDS: RecordDeletes = { fading: new Set(), remove: () => {}, restore: () => {} };
const NO_ACTIONS: ShelfActions = {
  openLink: () => {},
  openPullRequest: () => {},
  openSurface: () => {},
  openWeb: () => {},
  revealFile: () => {},
  copyFolder: () => {},
  revealFolder: () => {},
  runGate: () => {},
};

/** An agent whose page links to a page and a file and keeps a note, and whose pull request's checks are failing. */
const LINKED: Agent = {
  ...BUSY,
  sessionId: 'gallery-linked',
  pullRequests: [{ number: 490, title: 'Stream the CSV writer', url: 'https://github.com/acme/billing/pull/490', state: 'open', checks: 'failing' }],
  records: [],
  spawnedBy: null,
  page: {
    name: 'Try it',
    icon: 'flask-conical',
    writtenAt: at('10:40'),
    blocks: [
      {
        kind: 'links',
        title: 'Try it',
        icon: 'link',
        tone: 'blue',
        links: [
          { target: { kind: 'link', url: 'http://localhost:5173/exports' }, label: 'The export page' },
          { target: { kind: 'file', path: `${WORKTREE}/sample-export.csv` }, label: null },
          { target: { kind: 'file', path: `${WORKTREE}/docs/export.md` }, label: 'How the export works' },
        ],
      },
      { kind: 'note', title: 'Test logins', icon: 'key-round', tone: 'teal', text: 'ann, bob and cy\npassword: demo' },
    ],
  },
};

/** One agent's sidebar beside a stand-in terminal, open on `shelf`. With `alone`, technical details off, as under the Simplified design by default. */
function Frame({ agent, caption, shelf, peek, alone = false, folder, gate = GATE, width = 316, height = 760, testId }: { agent: Agent; caption: string; shelf?: ShelfId; peek?: ShelfId; alone?: boolean; folder?: string; gate?: GateRun; width?: number; height?: number; testId: string }) {
  return (
    <figure className="shelves-gallery-frame" data-testid={testId}>
      <figcaption>{caption}</figcaption>
      <div className="shelves-gallery-window" style={{ width: peek === undefined ? width + 160 : 420, height }}>
        <AgentShelves
          agent={agent}
          agents={AGENTS}
          shows="explicit"
          technical={!alone}
          folder={folder ?? agent.cwd}
          home={undefined}
          gate={agent.sessionId === BUSY_ID ? gate : null}
          now={NOW}
          records={NO_RECORDS}
          actions={NO_ACTIONS}
          width={width}
          collapsed={peek !== undefined}
          onCollapsed={() => {}}
          initialShelf={shelf}
          initialPeek={peek}
        />
        <div className="shelves-gallery-terminal" aria-hidden />
      </div>
    </figure>
  );
}

export function ShelvesGallery() {
  const styled = { ...BUSY, page: STYLED_PAGE };
  return (
    <section className="shelves-gallery" data-testid="shelves-gallery" aria-label="Agent sidebar">
      <h2>Agent sidebar</h2>
      <div className="shelves-gallery-row" data-testid="shelves-gallery-open">
        <Frame testId="shelves-busy" caption="Busy agent, its page, with its pins" agent={BUSY} height={1060} />
        <Frame testId="shelves-quiet" caption="Quiet agent, the board’s Now" agent={QUIET} height={560} />
        <Frame testId="shelves-styled" caption="Busy agent, its page, styled by the agent" agent={styled} height={1060} />
        <Frame testId="shelves-narrow" caption="Its page at 200px" agent={BUSY} width={200} height={1060} />
      </div>
      <div className="shelves-gallery-row" data-testid="shelves-gallery-rail">
        <Frame testId="rail-busy-page" caption="Rail: busy agent, its page in a peek" agent={BUSY} peek="page" height={1060} />
        <Frame testId="rail-quiet-page" caption="Rail: quiet agent, Now in a peek" agent={QUIET} peek="page" height={560} />
        <Frame testId="rail-busy-made" caption="Rail: busy agent, Made in a peek" agent={BUSY} peek="made" height={620} />
        <Frame testId="rail-busy-crew" caption="Rail: busy agent, Crew in a peek" agent={BUSY} peek="crew" height={620} />
        <Frame testId="rail-quiet-setup" caption="Rail: quiet agent, Setup in a peek" agent={QUIET} peek="setup" height={560} />
      </div>
      <div className="shelves-gallery-row" data-testid="shelves-gallery-shelves">
        <Frame testId="shelves-made" caption="Made" agent={BUSY} shelf="made" height={620} />
        <Frame testId="shelves-crew" caption="Crew" agent={BUSY} shelf="crew" height={620} />
        <Frame testId="shelves-setup" caption="Setup" agent={BUSY} shelf="setup" height={620} />
        <Frame testId="shelves-made-narrow" caption="Made at 200px" agent={BUSY} shelf="made" width={200} height={620} />
        <Frame testId="shelves-crew-narrow" caption="Crew at 200px" agent={BUSY} shelf="crew" width={200} height={620} />
        <Frame testId="shelves-setup-narrow" caption="Setup at 200px" agent={BUSY} shelf="setup" width={200} height={620} />
        <Frame testId="shelves-crew-wide" caption="Crew at 420px" agent={BUSY} shelf="crew" width={420} height={620} />
        <Frame testId="shelves-made-gate-failed" caption="Made, its gate failed" agent={BUSY} shelf="made" gate={FAILED_GATE} height={620} />
        <Frame testId="shelves-setup-gate-failed" caption="Setup, its gate failed" agent={BUSY} shelf="setup" gate={FAILED_GATE} height={620} />
        <Frame testId="shelves-setup-quiet" caption="Quiet agent, Setup, its folder outside its worktree" agent={QUIET} shelf="setup" folder="/tmp/elsewhere" height={620} />
        <Frame testId="shelves-made-plain" caption="Made, technical details off: no gate, a plain-words footer" agent={BUSY} shelf="made" alone height={620} />
        <Frame testId="shelves-linked" caption="Links and a note; a pull request failing" agent={LINKED} height={620} />
        <Frame testId="shelves-alone" caption="Its page the one shelf: its name and icon as a header" agent={{ ...QUIET, page: { ...LINKED.page!, blocks: LINKED.page!.blocks.slice(1) } }} alone height={360} />
      </div>
    </section>
  );
}
