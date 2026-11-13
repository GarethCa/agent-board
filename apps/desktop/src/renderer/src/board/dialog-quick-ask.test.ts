// Claude's own question dialog and plan approval as the board draws them: the quick ask in its dialog mode,
// Needs you's rows, the tile's chip and the Simplified pane's card, rendered from data alone.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent, PermissionPrompt, PromptQuestion } from '@agent-board/daemon/protocol';
import { PermissionRow } from '../inbox/PermissionRow';
import { PaneDecisions } from '../session/PaneDecision';
import { HybridTile } from './HybridTile';
import { QuickAsk, takesAllWords, type QuickAskActions } from './QuickAsk';
import { dialogAsk, type DialogPrompt } from './quick-ask';
import { galleryAgent } from './TileGallery';

const AT = '2026-11-12T10:00:00.000Z';
const QUESTIONS: PromptQuestion[] = [
  {
    question: 'Which cache should the product pages use?',
    header: 'Cache',
    options: [
      { label: 'Redis', description: 'Shared across the three web nodes' },
      { label: 'In-memory LRU', description: '' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which pages should it cover?',
    header: 'Scope',
    options: [
      { label: 'Product', description: '' },
      { label: 'Category', description: '' },
    ],
    multiSelect: true,
  },
];

const prompt = (fields: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
  id: 'q1',
  toolName: 'AskUserQuestion',
  toolInput: { questions: QUESTIONS },
  subagent: null,
  requestedAt: AT,
  heldUntil: '2026-11-13T10:00:00.000Z',
  asksInTerminal: true,
  sessionGrant: null,
  questions: QUESTIONS,
  dialog: { answers: [null, null], sentAt: null, keptOpen: false },
  plan: null,
  ...fields,
});

const PLAN = '# Add Redis in front of getProduct()\n\n1. Add a `cache.ts` client\n2. Wrap `getProduct()`, 5 min TTL';
const planPrompt = (fields: Partial<PermissionPrompt> = {}): PermissionPrompt =>
  prompt({ id: 'p1', toolName: 'ExitPlanMode', toolInput: { plan: PLAN }, questions: null, dialog: null, plan: PLAN, sessionGrant: 'all edits', ...fields });

const agent = (permissions: PermissionPrompt[]): Agent => ({ ...galleryAgent('waiting'), sessionId: 's1', name: 'Pick a cache', permissions, ask: null });
const ACTIONS: QuickAskActions = { answer: () => {}, send: () => {}, toTerminal: () => {} };

const quickAsk = (at: number, answers = prompt().dialog!.answers) =>
  renderToStaticMarkup(
    createElement(QuickAsk, { name: 'Pick a cache', ask: dialogAsk(prompt({ dialog: { answers, sentAt: null, keptOpen: false } }) as DialogPrompt), at, onAt: () => {}, actions: ACTIONS, still: true, dialog: true }),
  );
const row = (each: PermissionPrompt) => renderToStaticMarkup(createElement(PermissionRow, { agent: agent([each]), prompt: each, now: Date.parse(AT), onOpen: () => {} }));

describe("Claude's question dialog in the quick ask", () => {
  it('draws a question with its header, its options’ descriptions and the line saying where the answer goes', () => {
    const html = quickAsk(0);
    expect(html).toContain('Cache');
    expect(html).toContain('Shared across the three web nodes');
    expect(html).toContain('In Claude&#x27;s dialog · its terminal asks too');
    expect(html).toContain('Answer there');
    expect(html).toContain('Or in your words');
  });

  it('gives a question that takes several tick boxes, "(any)" and Next, off until something is ticked', () => {
    const html = quickAsk(1);
    expect(html).toContain('(any)');
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="quick-ask-next"/);
    // Ticked already, as kept in the daemon: Next is on.
    const ticked = quickAsk(1, [{ option: 0 }, { options: [1] }]);
    expect(ticked).toContain('aria-checked="true"');
    expect(ticked).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="quick-ask-next"/);
  });

  it('sends to its dialog only once every question is answered, and says Claude takes them at once', () => {
    expect(quickAsk(2, [{ option: 0 }, null])).toMatch(/<button[^>]*disabled=""[^>]*data-testid="quick-ask-send"/);
    const html = quickAsk(2, [{ option: 0 }, { options: [0, 1] }]);
    expect(html).toContain('Send to its dialog');
    expect(html).toContain('Product, Category');
    expect(html).toContain(takesAllWords(2));
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="quick-ask-send"/);
    expect(takesAllWords(1)).toBe('Claude takes the answer at once, as its Submit does.');
    expect(takesAllWords(3)).toBe('Claude takes all 3 answers at once, as its Submit does.');
  });
});

describe("Claude's question dialog in Needs you and the Captain's panel", () => {
  it('is the quick ask while the board can answer it', () => {
    const html = row(prompt());
    expect(html).toContain('data-testid="dialog-quick-ask"');
    expect(html).not.toContain('Allow');
  });

  it('says what became of the answers once sent, and when Claude kept its dialog open', () => {
    expect(row(prompt({ heldUntil: null, dialog: { answers: [{ option: 0 }, { options: [0] }], sentAt: AT, keptOpen: false } }))).toContain('data-testid="dialog-sent"');
    const kept = row(prompt({ heldUntil: null, dialog: { answers: [{ option: 0 }, { options: [0] }], sentAt: AT, keptOpen: true } }));
    expect(kept).toContain('Claude kept its dialog open. Answer it in its terminal.');
    expect(kept).toContain('Open');
  });

  it('stays read only where only its terminal can answer it: a subagent’s, or one it could not read', () => {
    const html = row(prompt({ dialog: null, subagent: { id: 'a1', type: 'Explore' } }));
    expect(html).toContain('data-testid="inbox-questions"');
    expect(html).toContain('Open the agent to answer');
  });
});

describe("Claude's plan approval (P1)", () => {
  it('reads "has a plan for you" with its title and first lines, and Claude’s choices in its words', () => {
    const html = row(planPrompt());
    expect(html).toContain('Pick a cache has a plan for you');
    expect(html).toContain('Add Redis in front of getProduct()');
    expect(html).toContain('Read the plan');
    expect(html).toContain('Yes, auto-accept edits');
    expect(html).toContain('Yes, approve each edit');
    expect(html).toContain('No, keep planning…');
    expect(html).toContain('Clear context or bypass permissions:');
    expect(html).not.toContain('ExitPlanMode');
  });

  it('offers auto-accept edits even where Claude suggested no switch, as the daemon sets the mode itself', () => {
    const html = row(planPrompt({ sessionGrant: null }));
    expect(html).toContain('Yes, auto-accept edits');
    expect(html).toContain('Yes, approve each edit');
  });
});

describe('on the tile and in the Simplified pane', () => {
  it('opens Claude’s dialog from the chip on its tile', () => {
    const one = agent([prompt()]);
    const html = renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: one.name, harness: one.harness, agent: one } } as never));
    expect(html).toContain('data-testid="ask-chip"');
    expect(html).toContain('2 questions');
  });

  it('has no chip where only its terminal can answer', () => {
    const one = agent([prompt({ dialog: null })]);
    const html = renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: one.name, harness: one.harness, agent: one } } as never));
    expect(html).not.toContain('data-testid="ask-chip"');
  });

  it('draws the dialog and the plan above the composer, never Allow and Deny', () => {
    const dialog = renderToStaticMarkup(createElement(PaneDecisions, { agent: agent([prompt()]) }));
    expect(dialog).toContain('data-kind="dialog"');
    expect(dialog).not.toContain('Allow');
    const plan = renderToStaticMarkup(createElement(PaneDecisions, { agent: agent([planPrompt()]) }));
    expect(plan).toContain('data-kind="claude-plan"');
    expect(plan).toContain('Yes, auto-accept edits');
  });
});
