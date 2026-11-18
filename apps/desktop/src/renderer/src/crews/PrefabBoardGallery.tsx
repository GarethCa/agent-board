import type { CrewPrefab, PrefabGate, PrefabInput, PrefabLine, PrefabMember, PrefabPlaces } from '@agent-board/daemon/protocol';
import { startsOf } from '@agent-board/daemon/prefab-graph';
import { tokenNumber } from '../theme';
import { PrefabBoard } from './PrefabBoard';
import { boardDraft, boardPlaces } from './prefab-board';

const nothing = () => {};

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
const to = (from: string, target: string, more: Omit<PrefabLine, 'from' | 'to'> = {}): PrefabLine => ({ from, to: target, ...more });
const PROMPT: PrefabInput = { id: 'prompt', kind: 'prompt' };
const READY: PrefabInput = { id: 'end', kind: 'end', as: 'ready' };
const loop = (cap: number | null, id = 'loop', timeout: number | null = null): PrefabGate => ({ id, rule: 'done', cap, atCap: 'ask', timeout });
/** A crew, each member's `starts` read from its lines, as the board saves it: else the board would redraw it from starts. */
type Drawn = { inputs: PrefabInput[]; gates: PrefabGate[]; lines: PrefabLine[] };
const crew = (fields: Pick<CrewPrefab, 'name' | 'members'> & Partial<CrewPrefab> & Drawn): CrewPrefab & Drawn => ({
  icon: 'crew',
  purpose: '',
  roundLimit: 3,
  onBoard: 'card',
  ...fields,
  members: fields.members.map((each) => ({ ...each, starts: startsOf(each.id, fields) })),
});
/** A builder and its reviewers, round a loop gate until they approve, then Ready: as the built-ins are. */
const reviewed = (builder: string, reviewers: string[]): PrefabLine[] => [
  to('prompt', builder),
  ...reviewers.map((reviewer) => to(builder, reviewer, { carries: 'handoff' })),
  ...reviewers.map((reviewer) => to(reviewer, 'loop', { carries: 'review' })),
  to('loop', builder, { way: 'again' }),
  to('loop', 'end', { way: 'done' }),
];

/**
 * A designer and a design reviewer round one loop gate, your OK, then a builder and two reviewers round another, which
 * waits 30 minutes for a late word, and Ready: the graph the canvas is first drawn with.
 */
const DESIGN_BUILD_REVIEW = crew({
  name: 'Design, build, review',
  icon: 'palette',
  purpose: 'A designer until the design is done, your OK, then a builder until both reviews approve',
  roundLimit: 5,
  members: [
    member({ id: 'designer', role: 'designer', name: 'designer', brief: 'Sketches two options before it picks one.', works: 'crew', starts: 'prompt' }),
    member({ id: 'design-review', role: 'reviewer', name: 'design review', brief: 'Checks it against the mocks and the tokens.', starts: 'handoff' }),
    member({ id: 'builder', name: 'builder', brief: 'Builds it test first, in small commits.', starts: 'handoff' }),
    member({ id: 'code-review', role: 'reviewer', name: 'code review', brief: 'Reads the tests first.', starts: 'handoff' }),
    member({ id: 'tests-review', role: 'reviewer', name: 'tests review', starts: 'handoff' }),
  ],
  inputs: [PROMPT, { id: 'ok', kind: 'user' }, READY],
  gates: [loop(5, 'design-loop'), loop(5, 'build-loop', 30)],
  lines: [
    to('prompt', 'designer'),
    to('designer', 'design-review', { carries: 'handoff' }),
    to('design-review', 'design-loop', { carries: 'review' }),
    to('design-loop', 'designer', { way: 'again' }),
    to('design-loop', 'ok', { way: 'done' }),
    to('ok', 'builder'),
    to('builder', 'code-review', { carries: 'handoff' }),
    to('builder', 'tests-review', { carries: 'handoff' }),
    to('code-review', 'build-loop', { carries: 'review' }),
    to('tests-review', 'build-loop', { carries: 'review' }),
    to('build-loop', 'builder', { way: 'again' }),
    to('build-loop', 'end', { way: 'done' }),
  ],
});

/**
 * A builder and two reviewers whose lines to the loop gate are not drawn yet, so it has no one to decide: placed where
 * the whole graph would put them, the gate at the right, as it is mid-drawing, not laid out again.
 */
function halfDrawn(): CrewPrefab & { places: PrefabPlaces } {
  const whole = crew({
    name: 'Two reviewers, half drawn',
    icon: 'review',
    purpose: 'One builds; a code reviewer and a design reviewer must both approve',
    members: [
      member({ id: 'impl', starts: 'prompt' }),
      member({ id: 'code-review', role: 'reviewer', name: 'code review', starts: 'handoff' }),
      member({ id: 'design-review', role: 'reviewer', name: 'design review', starts: 'handoff' }),
    ],
    inputs: [PROMPT, READY],
    gates: [loop(3)],
    lines: reviewed('impl', ['code-review', 'design-review']),
  });
  return { ...whole, lines: whole.lines.filter((line) => line.to !== 'loop'), places: boardPlaces(boardDraft(whole)) };
}

/**
 * Built-ins, and crews drawn to show each panel: an again line picked (the Line panel), two builders into an integration
 * review that waits for both (its join badge and the Agent panel), a clock picked (the Input panel), and a loop gate no
 * agent decides (the error on it, in the Prefab panel's list).
 */
const FRAMES: readonly { prefab: CrewPrefab & { places?: PrefabPlaces }; select?: string; size?: 'wide' }[] = [
  {
    prefab: crew({
      name: 'Implementer + reviewer',
      icon: 'review',
      purpose: 'One builds; a reviewer checks each hand-off until it approves',
      members: [member({ id: 'impl', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
      inputs: [PROMPT, READY],
      gates: [loop(3)],
      lines: reviewed('impl', ['review']),
    }),
    select: 'loop>impl',
  },
  {
    prefab: crew({
      name: 'Two builds, one review',
      members: [
        member({ id: 'web', name: 'web', starts: 'prompt', works: 'own' }),
        member({ id: 'api', name: 'api', starts: 'prompt', works: 'own' }),
        member({ id: 'integration', role: 'reviewer', name: 'integration review', brief: 'Checks the two halves fit.', join: 'all', timeout: 20, starts: 'handoff' }),
      ],
      inputs: [PROMPT, READY],
      gates: [],
      lines: [to('prompt', 'web'), to('prompt', 'api'), to('web', 'integration', { carries: 'handoff' }), to('api', 'integration', { carries: 'handoff' }), to('integration', 'end')],
    }),
    select: 'integration',
    size: 'wide',
  },
  {
    prefab: crew({
      name: 'Morning triage',
      icon: 'crew',
      purpose: 'Each weekday morning, one agent looks for new work',
      members: [member({ id: 'triage', name: 'triage', starts: 'prompt' })],
      inputs: [{ id: 'clock', kind: 'clock', schedule: '0 9 * * 1-5', line: 'Look for new work' }, READY],
      gates: [],
      lines: [to('clock', 'triage'), to('triage', 'end')],
    }),
    select: 'clock',
  },
  { prefab: halfDrawn(), size: 'wide' },
];

/**
 * A prefab's own board, drawn as a graph: Design, build, review as it opens and with its build loop gate picked, then
 * a frame for each other panel.
 */
export function PrefabBoardGallery() {
  const desk = { gap: tokenNumber('--desk-dot-gap'), size: tokenNumber('--desk-dot-size') };
  return (
    <section className="gallery-prefab-boards" data-testid="prefab-board-gallery">
      <div className="gallery-prefab-board" data-size="wide">
        <PrefabBoard start={{ prefab: DESIGN_BUILD_REVIEW, replaces: 'Design, build, review' }} desk={desk} onLeave={nothing} takesFocus={false} />
      </div>
      <div className="gallery-prefab-board" data-size="wide">
        <PrefabBoard start={{ prefab: DESIGN_BUILD_REVIEW, replaces: 'Design, build, review', select: 'build-loop' }} desk={desk} onLeave={nothing} takesFocus={false} />
      </div>
      <div className="gallery-prefab-built-ins">
        {FRAMES.map(({ prefab, select, size }) => (
          <div key={prefab.name} className="gallery-prefab-board" data-size={size}>
            <PrefabBoard start={{ prefab, replaces: null, ...(select === undefined ? {} : { select }) }} desk={desk} onLeave={nothing} takesFocus={false} />
          </div>
        ))}
      </div>
    </section>
  );
}
