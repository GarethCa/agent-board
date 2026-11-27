import type { Agent, AgentAsk, AskAnswer, AskQuestion, PermissionPrompt, PromptDialog, PromptQuestion } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { PlanPromptRow } from '../inbox/PlanPromptRow';
import { PopoverPreview } from '../ui';
import { DialogNote } from './DialogQuickAsk';
import { HybridTile } from './HybridTile';
import { QuickAsk, type QuickAskActions } from './QuickAsk';
import { dialogAsk, type DialogPrompt } from './quick-ask';
import { galleryAgent, JUST_NOW } from './TileGallery';

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
  askedAt: JUST_NOW,
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

const CACHE: PromptQuestion = {
  question: 'Which cache should the product pages use?',
  header: 'Cache',
  options: [
    { label: 'Redis', description: 'Shared across the three web nodes' },
    { label: 'In-memory LRU', description: 'One per node, gone on a restart' },
  ],
  multiSelect: false,
};
const SCOPE: PromptQuestion = {
  question: 'Which pages should it cover?',
  header: 'Scope',
  options: [
    { label: 'Product', description: '' },
    { label: 'Category', description: '' },
    { label: 'Search', description: '' },
    { label: 'Checkout', description: 'Prices change here most' },
  ],
  multiSelect: true,
};

const PLAN = [
  '# Add Redis in front of getProduct()',
  '',
  '1. Add a `cache.ts` client, its address from `REDIS_URL`',
  '2. Wrap `getProduct()`, with a 5 minute TTL',
  '3. Drop the entry when a product is saved',
  '4. Roll out behind the `product-cache` flag, on one node first',
  '',
  'The tests use an in-memory stand-in, so none needs Redis.',
].join('\n');

/** Claude's prompt as the daemon keeps it: its questions and the dialog's answers so far, or its plan. */
const claudePrompt = (fields: Partial<PermissionPrompt>): PermissionPrompt => ({
  id: 'gallery-prompt',
  toolName: 'AskUserQuestion',
  toolInput: {},
  subagent: null,
  requestedAt: JUST_NOW,
  heldUntil: AT,
  asksInTerminal: true,
  sessionGrant: null,
  questions: null,
  dialog: null,
  plan: null,
  ...fields,
});
const dialogPrompt = (questions: PromptQuestion[], dialog: Partial<PromptDialog> = {}) =>
  claudePrompt({ questions, toolInput: { questions }, dialog: { answers: questions.map(() => null), sentAt: null, keptOpen: false, ...dialog } }) as DialogPrompt;
const PLAN_PROMPT = claudePrompt({ id: 'gallery-plan', toolName: 'ExitPlanMode', toolInput: { plan: PLAN }, plan: PLAN, sessionGrant: 'auto mode' });
const PLANNER: Agent = { ...galleryAgent('waiting'), sessionId: 'gallery-planner', name: 'Pick a cache', permissions: [PLAN_PROMPT], ask: null, muted: false };

/** Claude's own dialog, open beside its tile at a question (`at`), as the board can answer it. */
const DIALOG_OPEN: { name: string; prompt: DialogPrompt; at: number }[] = [
  { name: 'Dialog: one question', prompt: dialogPrompt([CACHE]), at: 0 },
  { name: 'Dialog: several to tick', prompt: dialogPrompt([CACHE, SCOPE], { answers: [{ option: 0 }, { options: [0, 2] }] }), at: 1 },
  { name: 'Dialog: Other, in your words', prompt: dialogPrompt([CACHE, SCOPE], { answers: [{ text: 'Redis, but only for the product pages' }, null] }), at: 0 },
];

/** What becomes of its answers once sent: Claude takes them, or keeps its dialog open for its terminal. */
const DIALOG_AFTER: { name: string; prompt: DialogPrompt }[] = [
  { name: 'Dialog: sent', prompt: dialogPrompt([CACHE], { answers: [{ option: 0 }], sentAt: AT }) },
  { name: 'Dialog: kept open', prompt: dialogPrompt([CACHE], { answers: [{ option: 0 }], sentAt: AT, keptOpen: true }) },
];

const DIALOG_ACTIONS: QuickAskActions = { answer: () => {}, send: () => {}, toTerminal: () => {} };

/** The quick ask on Claude's own question dialog, open, sent and kept open, and its plan approval, for the visual shots. */
export function QuickAskDialogGallery() {
  return (
    <section className="gallery-quick-ask" data-testid="quick-ask-dialog-gallery">
      {DIALOG_OPEN.map(({ name, prompt, at }) => (
        <figure key={name} className="gallery-quick-ask-cell">
          <PopoverPreview className="quick-ask-popover" aria-label={name}>
            <QuickAsk name="Pick a cache" ask={dialogAsk(prompt)} at={at} onAt={() => {}} actions={DIALOG_ACTIONS} still dialog />
          </PopoverPreview>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      {DIALOG_AFTER.map(({ name, prompt }) => (
        <figure key={name} className="gallery-quick-ask-cell">
          <PopoverPreview className="quick-ask-popover" aria-label={name}>
            <DialogNote prompt={prompt} onOpen={() => {}} />
          </PopoverPreview>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      {[
        { name: 'Plan approval', read: false, prompt: PLAN_PROMPT },
        { name: 'Plan approval: the plan read', read: true, prompt: PLAN_PROMPT },
        { name: 'Plan approval: sent', read: false, prompt: { ...PLAN_PROMPT, heldUntil: null, planSent: { sentAt: AT, keptOpen: false } } },
        { name: 'Plan approval: kept open', read: false, prompt: { ...PLAN_PROMPT, heldUntil: null, planSent: { sentAt: AT, keptOpen: true } } },
      ].map(({ name, read, prompt }) => (
        <figure key={name} className="gallery-quick-ask-cell">
          {/* As a row of Needs you, in its popover. */}
          <PopoverPreview className="gallery-quick-ask-plan" aria-label={name}>
            <div className="inbox-item">
              <PlanPromptRow agent={PLANNER} prompt={prompt} plan={PLAN} onOpen={() => {}} read={read} />
            </div>
          </PopoverPreview>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </section>
  );
}
