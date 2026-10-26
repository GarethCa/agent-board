import type { PatchHunk } from './demo.ts';
import type { FakeSession } from './session.ts';

/**
 * The `demo-*` scenarios: one story told across a board's agents, drawn as the real TUIs look (`demo.ts`), for videos
 * and screenshots. A planner writes `plan.md`; an implementer codes, tests and opens a pull request; a reviewer asks
 * for changes in round 1 and approves in round 2; a Codex agent works on a second repo. The repos, issue and people are
 * made up. Nothing runs but the files they write (`plan.md`, `.agent-board/handover.md`): every other tool's answer is
 * canned.
 */

type DemoScript = (session: FakeSession, prompt: string) => Promise<void>;

const OK = (stdout: string) => ({ stdout, stderr: '', interrupted: false });

const PLAN = `# ACME-12: Apply discount codes at checkout

## Steps

1. Add \`applyDiscount()\` in \`src/cart/discount.ts\`: a percentage off, nothing for no code.
2. Take the discount in \`cartTotal()\` before tax, so tax is on what the customer pays.
3. Test a code, no code, and a 100% code in \`src/cart/total.test.ts\`.

## Out of scope

- Codes that stack. One code per cart for now.
`;

const CART_TOTAL = `import { sum, withTax, type Cart, type Money } from './money';
import { lineTotal } from './lines';

export function cartTotal(cart: Cart): Money {
  const subtotal = sum(cart.lines.map(lineTotal));
  return withTax(subtotal, cart.region);
}
`;

/** The implementer's change to the cart total: the discount taken before tax. */
const TOTAL_HUNK: PatchHunk = {
  oldStart: 4,
  newStart: 4,
  lines: [
    ' export function cartTotal(cart: Cart): Money {',
    '   const subtotal = sum(cart.lines.map(lineTotal));',
    '-  return withTax(subtotal, cart.region);',
    '+  const discounted = applyDiscount(subtotal, cart.code);',
    '+  return withTax(discounted, cart.region);',
    ' }',
  ],
};

/** The implementer's fix after round 1: an expired code no longer applies. */
const EXPIRY_HUNK: PatchHunk = {
  oldStart: 7,
  newStart: 7,
  lines: [
    ' export function applyDiscount(amount: Money, code?: DiscountCode): Money {',
    '-  if (!code) return amount;',
    '+  if (!code || code.expiresAt <= now()) return amount;',
    '   return amount.times(1 - code.pct / 100);',
    ' }',
  ],
};

const HANDOVER = `# ACME-12: Apply discount codes at checkout

## Problem
Discount codes were accepted at checkout but never taken off the total.

## Change
\`cartTotal()\` takes the code's discount before tax.

## How to verify
\`npm test\`: 12 passed. Pull request: https://github.com/acme/storefront/pull/12
`;

const HANDOVER_FIXED = `${HANDOVER}
## Round 2
An expired code no longer applies, with a test for it: 13 passed.
`;

/** The reviewer's doc for round 1, in the format the board reads: changes asked for. */
const FIRST_REVIEW = [
  '# Review of ACME-12: discount codes',
  '',
  'Verdict: Changes requested',
  '',
  '## Blocker',
  '- **An expired code still applies** `src/cart/discount.ts:8`: `expiresAt` is never checked.',
  '',
  '## Major',
  '- **No test for an expired code** `src/cart/total.test.ts:40`',
  '',
  '## Minor',
  '- **`pct` reads better as `percent`** `src/cart/discount.ts:9`',
].join('\n');

/** The reviewer's doc for round 2 on: the blocker and major fixed, the minor left. */
const LATER_REVIEW = [
  '# Review of the fixes',
  '',
  'Verdict: Approve',
  '',
  '## Blocker',
  '- ~~**An expired code still applies**~~ `src/cart/discount.ts:8`',
  '',
  '## Major',
  '- ~~**No test for an expired code**~~ `src/cart/total.test.ts:40`',
  '',
  '## Minor',
  '- **`pct` reads better as `percent`** `src/cart/discount.ts:9`',
].join('\n');

/** Runs `turn` for the first prompt, then again for each later one, numbered from 1, until stdin closes. */
async function everyTurn(session: FakeSession, prompt: string, turn: (prompt: string, count: number) => Promise<void>): Promise<void> {
  for (let count = 1; ; count++) {
    await turn(prompt, count);
    const next = await session.waitForInput();
    if (next === undefined) return session.end('prompt_input_exit');
    prompt = next;
  }
}

export const demoScripts: Record<'demo-plan' | 'demo-implement' | 'demo-review' | 'demo-codex', DemoScript> = {
  /** A planner: reads the cart code, lists its steps and writes them to `plan.md` for real. */
  async 'demo-plan'(session, prompt) {
    await session.submit(prompt);
    await session.think();
    await session.say("I'll look at how the cart total is worked out first.");
    await session.runTool('Read', { file_path: 'src/cart/total.ts' }, CART_TOTAL);
    await session.runTool('Grep', { pattern: 'cartTotal' }, 'src/checkout/summary.ts:14\nsrc/api/cart.ts:31');
    await session.think();
    await session.updateTodos([
      { content: 'Add applyDiscount()', status: 'pending' },
      { content: 'Discount before tax in cartTotal()', status: 'pending' },
      { content: 'Test codes, no code, 100% off', status: 'pending' },
    ]);
    await session.writeFile('plan.md', PLAN);
    await session.say('The plan is in plan.md: three steps, discount before tax, one code per cart.');
    await session.stop();
  },

  /**
   * An implementer: codes the plan with an explorer's help (held for `FAKE_HARNESS_SUBAGENT_WORK_MS`), runs the tests
   * (12 passed), asks permission for `rm -rf dist`, opens a pull request and writes `.agent-board/handover.md`. Each
   * later prompt is a review's findings: it fixes them, tests again (13 passed) and pushes.
   */
  async 'demo-implement'(session, prompt) {
    const workMs = Number(process.env.FAKE_HARNESS_SUBAGENT_WORK_MS ?? 0);
    await everyTurn(session, prompt, async (text, count) => {
      await session.submit(text);
      await session.think();
      if (count > 1) {
        await session.say("I'll fix the blocker and the major from the review.");
        await session.edit('src/cart/discount.ts', EXPIRY_HUNK);
        await session.runTool(session.shellTool, { command: 'npm test', description: 'Run the tests' }, OK('13 passed'));
        await session.runTool(session.shellTool, { command: 'git push', description: 'Push the fix' }, OK('a41c9e2..7d03b18  acme-12-discount-codes -> acme-12-discount-codes'));
        await session.writeFile('.agent-board/handover.md', HANDOVER_FIXED);
        await session.say('Fixed both: an expired code no longer applies, and it has a test. Pushed to #12.');
        return session.stop();
      }
      const todos = (done: number) =>
        ['Add applyDiscount()', 'Discount before tax in cartTotal()', 'Run the tests', 'Open the pull request'].map((content, at) => ({
          content,
          status: at < done ? ('completed' as const) : at === done ? ('in_progress' as const) : ('pending' as const),
        }));
      await session.updateTodos(todos(0));
      await session.spawnSubagent('Explore', 'Find every caller of cartTotal', async () => {
        await new Promise((resolve) => setTimeout(resolve, workMs));
        return 'cartTotal is called from src/checkout/summary.ts and src/api/cart.ts.';
      });
      await session.runTool('Read', { file_path: 'src/cart/total.ts' }, CART_TOTAL);
      await session.edit('src/cart/total.ts', TOTAL_HUNK);
      await session.updateTodos(todos(2));
      await session.runTool(session.shellTool, { command: 'npm test', description: 'Run the tests' }, OK('12 passed'));
      await session.say('All 12 pass. The build folder is stale, so I need to clear it before building.');
      const cleared = await session.runTool(session.shellTool, { command: 'rm -rf dist', description: 'Remove the stale build' }, OK(''), true);
      if (cleared) await session.runTool(session.shellTool, { command: 'npm run build', description: 'Build' }, OK('built in 1.4s'));
      await session.updateTodos(todos(3));
      await session.runTool(session.shellTool, { command: 'git push -u origin acme-12-discount-codes', description: 'Push the branch' }, OK("branch 'acme-12-discount-codes' set up to track 'origin/acme-12-discount-codes'."));
      await session.runTool(
        session.shellTool,
        { command: 'gh pr create --title "ACME-12: Apply discount codes at checkout" --fill', description: 'Open the pull request' },
        OK('https://github.com/acme/storefront/pull/12'),
      );
      await session.writeFile('.agent-board/handover.md', HANDOVER);
      await session.updateTodos(todos(4));
      await session.say('Opened #12: discount codes come off the total before tax, and all 12 tests pass.');
      await session.stop();
    });
  },

  /**
   * A reviewer: reads the pull request and ends on a review doc, changes requested in round 1 and approved from round 2.
   * The round is the one its prompt names (`reviewer for round N`), else how many prompts it has had.
   */
  async 'demo-review'(session, prompt) {
    await everyTurn(session, prompt, async (text, count) => {
      const round = Number(/reviewer for round (\d+)/.exec(text)?.[1] ?? count);
      await session.submit(text);
      await session.think();
      await session.runTool(session.shellTool, { command: 'gh pr diff 12 --name-only', description: 'List the changed files' }, OK(['src/cart/discount.ts', 'src/cart/total.ts', 'src/cart/total.test.ts'].join('\n')));
      if (round > 1) {
        await session.runTool(session.shellTool, { command: 'npm test', description: 'Run the tests' }, OK('13 passed'));
        await session.think();
        await session.say(LATER_REVIEW);
        return session.stop();
      }
      await session.runTool('Read', { file_path: 'src/cart/discount.ts' }, 'export function applyDiscount(amount: Money, code?: DiscountCode): Money {\n  if (!code) return amount;\n  return amount.times(1 - code.pct / 100);\n}\n');
      await session.think();
      await session.say(FIRST_REVIEW);
      await session.stop();
    });
  },

  /** A Codex agent in a second repo: adds idempotency keys to refunds, asks permission to migrate, tests (8 passed). */
  async 'demo-codex'(session, prompt) {
    await session.submit(prompt);
    await session.think();
    await session.updateTodos([
      { content: 'Find where refunds are created', status: 'in_progress' },
      { content: 'Store an idempotency key per refund', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ]);
    await session.runTool(session.shellTool, { command: 'rg -n "createRefund" src', description: 'Find refunds' }, OK('src/refunds/create.ts:12:export async function createRefund(req: RefundRequest) {\nsrc/api/refunds.ts:20:  const refund = await createRefund(body);'));
    await session.edit('src/refunds/create.ts', {
      oldStart: 12,
      newStart: 12,
      lines: [
        ' export async function createRefund(req: RefundRequest) {',
        '+  const earlier = await refunds.byKey(req.idempotencyKey);',
        '+  if (earlier) return earlier;',
        '   const refund = await gateway.refunds.create(req.params);',
      ],
    });
    await session.runTool(session.shellTool, { command: 'npm run migrate', description: 'Add the idempotency_key column' }, OK('migrated 0007_refund_idempotency_key'), true);
    await session.runTool(session.shellTool, { command: 'npm test', description: 'Run the tests' }, OK('8 passed'));
    await session.updateTodos([
      { content: 'Find where refunds are created', status: 'completed' },
      { content: 'Store an idempotency key per refund', status: 'completed' },
      { content: 'Run the tests', status: 'completed' },
    ]);
    await session.say('Refunds now take an Idempotency-Key: a retried request gets the first refund back. 8 passed.');
    await session.stop();
  },
};
