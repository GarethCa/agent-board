import { useRef, useState } from 'react';
import { ZONE_COLORS, type Agent, type AgentPage, type BoardItem, type PlanSummary, type Zone } from '@agent-board/daemon/protocol';
import { AgentShelves, type ShelfActions } from '../session/AgentShelves';
import type { RecordDeletes } from '../session/RecordList';
import type { ShelfId } from '../session/shelves';
import { Inbox } from '../inbox/Inbox';
import { FixedNow } from '../inbox/use-now';
import { ZoneJump } from '../chrome/ZoneJump';
import { ForYou } from '../master/MasterPanel';
import { SinceYouLooked } from '../master/SinceYouLooked';
import { longAgent } from './LongTextGallery';
import { EMOJI, LONG_PATH, LONG_SENTENCE, LONG_URL, NO_SPACES, OTHER_SCRIPTS } from './long-text';

const AT = '2026-01-01T09:00:00.000Z';
/** When the agents below finished and the Captain last said what comes next: after the user's last look. */
const LATER = '2026-01-01T09:05:00.000Z';
/** The user's last look at the Needs-you list, kept where the app keeps it: before the agents finished. */
const LOOKED = Date.parse('2026-01-01T08:00:00.000Z');
/** Keeps the user's last look where the app keeps it, before the digest first reads it: on this page only. */
function seedLastLook() {
  try {
    localStorage.setItem('agent-board.pane-last-looked', String(LOOKED));
  } catch {
    // Where storage is blocked, the look is now and the digest is not drawn.
  }
  return true;
}
const NOW = new Date('2026-01-01T09:10:00.000Z');
const noop = () => {};

/** A page with every kind of block, each filled with long text. */
const PAGE: AgentPage = {
  name: 'Long',
  icon: 'flask-conical',
  writtenAt: AT,
  blocks: [
    { kind: 'heading', title: NO_SPACES, icon: null, tone: 'blue', text: LONG_PATH, progress: 40 },
    {
      kind: 'figures',
      title: null,
      icon: null,
      tone: 'neutral',
      figures: [
        { value: NO_SPACES, label: OTHER_SCRIPTS, icon: null, tone: 'green' },
        { value: EMOJI, label: NO_SPACES, icon: null, tone: 'violet' },
      ],
    },
    {
      kind: 'checklist',
      title: OTHER_SCRIPTS,
      icon: null,
      tone: 'neutral',
      items: [
        { text: NO_SPACES, state: 'done' },
        { text: LONG_URL, state: 'doing' },
        { text: EMOJI, state: 'todo' },
      ],
    },
    { kind: 'callout', title: null, icon: 'link', tone: 'teal', text: LONG_URL },
    {
      kind: 'links',
      title: NO_SPACES,
      icon: 'link',
      tone: 'blue',
      links: [
        { target: { kind: 'link', url: LONG_URL }, label: null },
        { target: { kind: 'file', path: LONG_PATH }, label: NO_SPACES },
      ],
    },
    { kind: 'note', title: NO_SPACES, icon: 'key-round', tone: 'teal', text: `${NO_SPACES}\n${LONG_PATH}` },
  ],
};

const SIDEBAR_AGENT: Agent = { ...longAgent('sidebar', NO_SPACES), page: PAGE };
const NOW_AGENT: Agent = { ...longAgent('now', NO_SPACES), page: null };

/** Agents that need the user, each for a different reason, with long text in what it says. */
const inboxAgent = (key: string, fields: Partial<Agent>): Agent => ({
  ...longAgent(key, NO_SPACES),
  state: 'waiting',
  permissions: [],
  ask: null,
  plan: null,
  flag: null,
  stepsWait: null,
  removeAsk: null,
  seen: false,
  ...fields,
});
const INBOX: Agent[] = [
  inboxAgent('flag', { flag: { id: 1, reason: NO_SPACES, at: AT, to: 'user', via: NO_SPACES }, lastMessage: LONG_URL }),
  inboxAgent('ask', {
    ask: {
      id: 'long-ask',
      question: LONG_PATH,
      options: [NO_SPACES, EMOJI],
      freeText: false,
      askedAt: AT,
      expiresAt: '2026-01-01T10:00:00.000Z',
      onBoard: false,
      questions: [{ question: LONG_PATH, options: [NO_SPACES, EMOJI], freeText: false }],
      answers: [null],
      card: null,
    },
  }),
  inboxAgent('permission', {
    permissions: [
      {
        id: 'long-permission',
        toolName: 'Bash',
        toolInput: { command: `cat ${LONG_PATH} ${NO_SPACES}` },
        subagent: { id: 'sub', type: NO_SPACES },
        requestedAt: AT,
        heldUntil: null,
        asksInTerminal: false,
        sessionGrant: null,
        questions: null,
        dialog: null,
        plan: null,
      },
    ],
  }),
  inboxAgent('sentence', { flag: { id: 2, reason: LONG_SENTENCE, at: AT, to: 'user', via: null }, lastMessage: OTHER_SCRIPTS }),
  inboxAgent('destructive', {
    permissions: [
      {
        id: 'long-destructive',
        toolName: 'Bash',
        toolInput: { command: `rm -rf ${LONG_PATH}/${NO_SPACES}` },
        subagent: null,
        requestedAt: AT,
        heldUntil: null,
        asksInTerminal: false,
        sessionGrant: null,
        questions: null,
        dialog: null,
        plan: null,
      },
    ],
  }),
  inboxAgent('plan', {
    plan: { id: 'long-plan', version: 2, title: NO_SPACES, format: 'markdown', presentedAt: AT, expiresAt: null, left: true, decision: null, author: 'agent', path: LONG_PATH } as PlanSummary,
  }),
  inboxAgent('steps', {
    stepsWait: { kind: 'steps', itemId: 'long-steps', title: NO_SPACES, stepId: 'long-step', text: LONG_URL, open: 3, since: AT },
  }),
  inboxAgent('todo', {
    stepsWait: { kind: 'todo', itemId: 'long-todo', title: OTHER_SCRIPTS, stepId: 'long-todo-step', text: NO_SPACES, open: 0, since: AT },
  }),
  inboxAgent('remove', {
    removeAsk: {
      id: 'long-remove',
      askedAt: AT,
      expiresAt: '2026-01-01T10:00:00.000Z',
      tiles: [
        { sessionId: 'long-remove-a', name: NO_SPACES, held: null },
        { sessionId: 'long-remove-b', name: EMOJI, held: LONG_SENTENCE },
      ],
    },
  }),
];

/** The Captain, with long text in what it says comes next, and agents that finished with long summaries since the last look. */
const CAPTAIN: Agent = { ...longAgent('captain', NO_SPACES), master: true, endedAt: null, status: { summary: LONG_URL, progress: null, updatedAt: LATER, setBy: null } };
const finished = (key: string, summary: string): Agent => ({ ...longAgent(key, NO_SPACES), state: 'idle', workFinishedAt: LATER, status: { summary, progress: null, updatedAt: LATER, setBy: null } });
const MASTER_AGENTS: Agent[] = [CAPTAIN, ...INBOX, ...[NO_SPACES, LONG_PATH, OTHER_SCRIPTS, EMOJI, LONG_SENTENCE, LONG_URL].map((summary, at) => finished(`done-${at}`, summary))];
/** The Captain's digest: a note beside its tile. */
const DIGEST: BoardItem[] = [
  {
    id: 'long-digest',
    kind: 'agent-note',
    zoneId: null,
    ticket: null,
    x: 0,
    y: 0,
    width: 280,
    height: 200,
    z: 0,
    rotation: 0,
    data: { text: `${NO_SPACES}\n\n${LONG_PATH} ${LONG_URL}`, agent: { sessionId: CAPTAIN.sessionId, name: NO_SPACES, harness: 'claude', role: null }, writtenAt: AT },
    createdAt: AT,
    updatedAt: AT,
  } as BoardItem,
];

const ZONES: Zone[] = [NO_SPACES, OTHER_SCRIPTS, EMOJI, 'Short'].map((name, at) => ({ id: `long-zone-${at}`, name, color: ZONE_COLORS[at % ZONE_COLORS.length], x: at * 2000, y: 0 }) as Zone);

const ACTIONS: ShelfActions = {
  openLink: noop,
  openPullRequest: noop,
  openSurface: noop,
  openWeb: noop,
  revealFile: noop,
  copyFolder: noop,
  revealFolder: noop,
  runGate: noop,
};
const NO_RECORDS: RecordDeletes = { fading: new Set(), remove: noop, restore: noop };

/** An agent's sidebar open on `shelf`, in a box of its width, as tall as all it shows. */
function Sidebar({ agent, shelf, width = 316 }: { agent: Agent; shelf?: ShelfId; width?: number }) {
  return (
    <div className="long-text-box long-text-panel" style={{ width }} data-testid="long-text-box">
      <AgentShelves
        agent={agent}
        agents={[agent]}
        shows="explicit"
        technical
        folder={LONG_PATH}
        home={undefined}
        gate={null}
        now={NOW}
        records={NO_RECORDS}
        actions={ACTIONS}
        width={width}
        collapsed={false}
        onCollapsed={noop}
        initialShelf={shelf}
      />
    </div>
  );
}

/** The Captain's panel, Classic's: its For you list with the needs-you rows and its digest. */
function MasterForYou() {
  const panel = useRef<HTMLElement>(null);
  return (
    <aside ref={panel} className="master-panel long-text-master" aria-label="Captain">
      <ForYou panel={panel} agents={MASTER_AGENTS} zones={[]} items={DIGEST} master={CAPTAIN} onOpenAgent={noop} onOpenLink={noop} />
    </aside>
  );
}

/**
 * The panels with long text in every field they show: an agent's sidebar (its page, Now, Made and Setup), the needs-you
 * inbox, the Captain's For you list and Simplified's "since you last looked", and the zone bar. Nothing in them may run past its box. The app shows it at `#gallery-long-text-panels`.
 */
export function LongTextPanelsGallery() {
  // Before its children first render, so the digest reads this look; never at import, which every window does.
  useState(seedLastLook);
  return (
    // Every age and countdown in it from `NOW`, not the clock, so it looks the same on any day.
    <FixedNow.Provider value={NOW.getTime()}>
      <section className="long-text-gallery" data-testid="long-text-gallery" aria-label="Long text in panels">
        <div className="long-text-gallery-row">
          <Sidebar agent={SIDEBAR_AGENT} />
          <Sidebar agent={NOW_AGENT} />
          <Sidebar agent={SIDEBAR_AGENT} shelf="made" />
          <Sidebar agent={SIDEBAR_AGENT} shelf="setup" />
          <Sidebar agent={SIDEBAR_AGENT} width={200} />
        </div>
        <div className="long-text-gallery-row">
          <div className="long-text-box long-text-panel" style={{ width: 380 }} data-testid="long-text-box">
            <Inbox agents={INBOX} zones={[]} onOpen={noop} heading={false} />
          </div>
          <div className="long-text-box long-text-panel" style={{ width: 380 }} data-testid="long-text-box">
            <MasterForYou />
          </div>
          <div className="long-text-box long-text-panel" style={{ width: 380 }} data-testid="long-text-box">
            <SinceYouLooked agents={MASTER_AGENTS} onOpenAgent={noop} />
          </div>
        </div>
        <div className="long-text-gallery-row">
          {/* Wide enough for the bar to reach its widest, so a zone's name ends in its own ellipsis. */}
          <div className="long-text-box long-text-zones" style={{ width: 1100 }} data-testid="long-text-box">
            <ZoneJump zones={ZONES} current={ZONES[0]!.id} onJump={noop} onKeyboardHelp={noop} />
          </div>
        </div>
      </section>
    </FixedNow.Provider>
  );
}
