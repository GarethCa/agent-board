import type { LibraryPrefab, PrefabMember } from '@agent-board/daemon/protocol';
import { PrefabEditor } from './PrefabEditor';

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
