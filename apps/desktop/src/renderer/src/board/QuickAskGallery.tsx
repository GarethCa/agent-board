import type { Agent, AgentAsk, AskAnswer, AskQuestion } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { PopoverPreview } from '../ui';
import { HybridTile } from './HybridTile';
import { QuickAsk, type QuickAskActions } from './QuickAsk';
import { galleryAgent } from './TileGallery';

const AT = '2026-01-01T00:00:00.000Z';

const QUESTIONS: AskQuestion[] = [
  { question: 'Where should the rate limiter live?', options: ['In the gateway', 'In each service', 'A shared library'], freeText: false },
  { question: 'Keep the old limit for internal calls?', options: ['Yes', 'No'], freeText: false },
  { question: 'Anything else I should know?', options: [], freeText: true },
];

const ask = (questions: AskQuestion[], answers: (AskAnswer | null)[], fields: Partial<AgentAsk> = {}): AgentAsk => ({
  id: 'gallery-ask',
  question: questions[0]!.question,
  options: questions[0]!.options,
  freeText: questions[0]!.freeText,
  askedAt: AT,
  expiresAt: AT,
  onBoard: false,
  questions,
  answers,
  card: null,
  ...fields,
});

const SINGLE: AskQuestion[] = [{ question: 'Ship the fix on Friday?', options: ['Yes', 'No, Monday'], freeText: true }];
const ONE_IN = ask(QUESTIONS, [{ option: 0 }, null, null]);
const ALL_IN = ask(QUESTIONS, [{ option: 0 }, { option: 1 }, { text: 'The admin API has its own limit.' }]);

const asking = (name: string, asked: AgentAsk): Agent => ({ ...galleryAgent('waiting'), sessionId: `gallery-${name}`, name, permissions: [], ask: asked, muted: false });

/** Asking tiles: the chip and how many it asks, one put on the board. */
const TILES: { name: string; agent: Agent }[] = [
  { name: 'Asks 3 questions, one answered', agent: asking('impl-2', ONE_IN) },
  { name: 'Asks 1 question', agent: asking('web-2', ask(SINGLE, [null])) },
  { name: 'Put on the board', agent: asking('impl-3', { ...ONE_IN, card: 'gallery-card' }) },
];

/** The ask open beside its tile, at each place it can be. */
const OPEN: { name: string; data: AgentAsk; at: number; asker?: string }[] = [
  // An agent named from its prompt, as most are: its name gives way, and the head stays one line.
  { name: 'Open: a question with its keys', data: ONE_IN, at: 1, asker: 'Where should the rate limiter live, and should it keep the old limit' },
  { name: 'Open: a question in words', data: ONE_IN, at: 2 },
  { name: 'Open: the answers and Send', data: ALL_IN, at: 3 },
  { name: 'Open: a single question', data: ask(SINGLE, [null]), at: 0 },
];

const ACTIONS: QuickAskActions = { answer: () => {}, send: () => {}, skip: () => {}, toCard: () => {} };

/** The quick ask on an agent's tile, from data alone: its chip on the tile, and the ask open, for the visual shots. */
export function QuickAskGallery() {
  return (
    <section className="gallery-quick-ask" data-testid="quick-ask-gallery">
      {TILES.map(({ name, agent }) => (
        <figure key={name} className="gallery-quick-ask-cell">
          <div style={AGENT_TILE_SIZE}>
            <HybridTile id={`quick-ask-${agent.sessionId}`} tile={{ label: agent.name, harness: agent.harness, agent }} />
          </div>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      {OPEN.map(({ name, data, at, asker = 'impl-2' }) => (
        <figure key={name} className="gallery-quick-ask-cell">
          <PopoverPreview className="quick-ask-popover" aria-label={name}>
            <QuickAsk name={asker} ask={data} at={at} onAt={() => {}} actions={ACTIONS} still />
          </PopoverPreview>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </section>
  );
}
