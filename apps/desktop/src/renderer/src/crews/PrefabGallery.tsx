import type { LibraryPrefab, PrefabMember, Zone } from '@agent-board/daemon/protocol';
import { CrewPromptDialog } from './CrewPromptDialog';
import { NewTicketDialog } from './NewTicketDialog';
import { PrefabEditor } from './PrefabEditor';
import { PrefabsDialog } from './PrefabsDialog';

const member = (fields: Partial<PrefabMember> & Pick<PrefabMember, 'id' | 'starts'>): PrefabMember => ({
  role: 'implementer',
  name: null,
  harness: 'claude',
  model: null,
  effort: null,
  template: null,
  subagents: [],
  ...fields,
});

/** The built-in a crew of three is drawn from: a builder and two reviewers, picked on its builder. */
const TRIO: LibraryPrefab = {
  name: 'Implementer + code + design reviewers',
  icon: 'review',
  purpose: 'One builds; a code reviewer and a design reviewer must both approve',
  roundLimit: 3,
  onBoard: 'card',
  builtIn: false,
  editedAt: '2026-01-01T00:00:00.000Z',
  members: [
    member({ id: 'builder', name: 'Builder', model: 'opus', effort: 'high', starts: 'prompt' }),
    member({ id: 'code-review', role: 'reviewer', name: 'Code review', model: 'sonnet', effort: 'medium', starts: 'handoff' }),
    member({ id: 'design-review', role: 'reviewer', name: 'Design review', harness: 'codex', model: 'gpt-5', effort: 'high', starts: 'handoff' }),
  ],
};

/** A lead and the crew it starts itself, picked on a member the lead starts, drawn as member tiles. */
const LED: LibraryPrefab = {
  name: 'Lead and crew',
  icon: 'lead',
  purpose: 'An orchestrator that starts and steers its own crew',
  roundLimit: 2,
  onBoard: 'tiles',
  builtIn: true,
  editedAt: null,
  members: [
    member({ id: 'lead', role: 'orchestrator', model: 'opus', starts: 'prompt' }),
    member({ id: 'impl', starts: 'lead' }),
    member({ id: 'review', role: 'reviewer', starts: 'lead' }),
  ],
};

/** A crew of five reviewers, the most a stack draws before it scrolls: the loop must still run under them all. */
const BIG: LibraryPrefab = {
  ...TRIO,
  name: 'Five checks',
  purpose: '',
  members: [
    TRIO.members[0]!,
    ...['Code', 'Design', 'Security', 'Tests', 'Docs'].map((name) => member({ id: `${name.toLowerCase()}-review`, role: 'reviewer', name: `${name} review`, starts: 'handoff' })),
  ],
};

/**
 * The crew prefab flow editor, drawn open in place: a crew with two reviewers (its builder picked), a copy of a
 * built-in lead's (a member it starts picked), and a crew of five reviewers.
 */
export function PrefabGallery() {
  return (
    <section className="gallery-prefabs" data-testid="prefab-gallery">
      <PrefabEditor prefab={TRIO} onClose={() => {}} inline picked="builder" />
      <PrefabEditor prefab={LED} onClose={() => {}} inline picked="impl" />
      <PrefabEditor prefab={BIG} onClose={() => {}} inline picked="security-review" />
    </section>
  );
}

const SOLO: LibraryPrefab = { ...TRIO, name: 'Solo agent', icon: 'agent', purpose: 'One agent, as New agent starts it', builtIn: true, editedAt: null, members: [member({ id: 'agent', starts: 'prompt' })] };
const PAIR: LibraryPrefab = { ...TRIO, name: 'Implementer + reviewer', purpose: 'Build, review, fix, until the review approves', builtIn: true, editedAt: null, members: [TRIO.members[0]!, TRIO.members[1]!] };
const ZONE = { id: 'gallery-web', name: 'web', repoRoot: '/code/web', defaultRepo: null, clone: null } as unknown as Zone;
const nothing = () => {};

const GROUP = { id: 'gallery-group', name: 'scratch', repoRoot: null, defaultRepo: null, clone: null } as unknown as Zone;

/**
 * The crew library's cards, yours first, one asking before it is removed, and a crew's prompt box: named its zone, with
 * a loop; asking for a zone; asking for a repo in a group; and on a board with no zone to start in.
 */
export function CrewGallery() {
  return (
    <section className="gallery-prefabs" data-testid="crew-gallery">
      <PrefabsDialog onClose={nothing} onStart={nothing} onEdit={nothing} onImport={nothing} asking="Five checks" library={{ prefabs: [SOLO, PAIR, LED, TRIO, BIG], unreadable: [{ name: 'From a later release', reason: 'the round limit is a whole number from 1 to 10' }] }} />
      <CrewPromptDialog prefab={TRIO} zones={[ZONE]} zone={ZONE} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
      <CrewPromptDialog prefab={SOLO} zones={[ZONE, GROUP]} zone={undefined} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
      <CrewPromptDialog prefab={PAIR} zones={[GROUP]} zone={GROUP} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
      <CrewPromptDialog prefab={PAIR} zones={[]} zone={undefined} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
    </section>
  );
}

/** The built-in ticket prefabs, as the library lists them: who builds, and the helpers each starts. */
const TICKETS: LibraryPrefab[] = [
  {
    name: 'Ticket',
    icon: 'ticket',
    purpose: 'A ticket whose chat builds, and a reviewer once it hands off',
    roundLimit: 3,
    onBoard: 'ticket',
    ticketChat: 'implementer',
    builtIn: true,
    editedAt: null,
    members: [member({ id: 'chat', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
  },
  {
    name: 'Design, build, review',
    icon: 'ticket',
    purpose: 'A ticket led by its chat: a designer, a builder and a reviewer',
    roundLimit: 3,
    onBoard: 'ticket',
    ticketChat: 'lead',
    builtIn: true,
    editedAt: null,
    members: [
      member({ id: 'chat', role: 'orchestrator', starts: 'prompt' }),
      member({ id: 'design', role: 'designer', model: 'opus', effort: 'high', starts: 'lead' }),
      member({ id: 'build', name: 'builder', model: 'opus', effort: 'medium', starts: 'lead' }),
      member({ id: 'review', role: 'reviewer', model: 'opus', effort: 'medium', starts: 'handoff' }),
    ],
  },
  {
    name: 'Just the chat',
    icon: 'ticket',
    purpose: 'A ticket with its chat alone: it builds, and starts any helper it needs',
    roundLimit: 3,
    onBoard: 'ticket',
    ticketChat: 'implementer',
    builtIn: true,
    editedAt: null,
    members: [member({ id: 'chat', starts: 'prompt' })],
  },
];

/** New ▸ Ticket: in a zone, the implementer by default; a prefab asked for that leads; and asking for a zone, one with no repo. */
export function TicketGallery() {
  return (
    <section className="gallery-prefabs" data-testid="ticket-gallery">
      <NewTicketDialog prefabs={TICKETS} zones={[ZONE]} zone={ZONE} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
      <NewTicketDialog prefabs={TICKETS} prefab="design, build, review" zones={[ZONE]} zone={ZONE} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
      <NewTicketDialog prefabs={TICKETS} zones={[GROUP, ZONE]} zone={undefined} onAddZone={nothing} onStarted={nothing} onCancel={nothing} inline />
    </section>
  );
}
