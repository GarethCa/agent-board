import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { FlowEdge } from '@agent-board/daemon/protocol';
import { agents, launch, recordedStates, recordStates, spawnAgent, tile, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const flowEdges = (page: Page): Promise<FlowEdge[]> => page.evaluate(() => window.agentBoard.flowEdges.list());
const answer = (page: Page, sessionId: string, text: string): Promise<void> =>
  page.evaluate(([id, typed]) => window.agentBoard.agents.answer(id!, typed!), [sessionId, text]);
const deleteAgent = (page: Page, sessionId: string) => page.evaluate((id) => window.agentBoard.agents.delete(id, true), sessionId);
const connectors = (page: Page) => page.evaluate(() => window.agentBoard.connectors.list());
const join = (page: Page, from: string, to: string): Promise<FlowEdge> =>
  page.evaluate(([a, b]) => window.agentBoard.flowEdges.create({ from: a!, to: b! }), [from, to]);
/** Moves the second agent's tile well clear of the first, so the edge between them has room for its label. */
async function spaceApart(page: Page, first: string, second: string): Promise<void> {
  const [zone] = await zones(page);
  await page.evaluate(
    async ({ zoneId, first, second }) => {
      await window.agentBoard.agents.move(first, { zoneId, x: 20, y: 40 });
      await window.agentBoard.agents.move(second, { zoneId, x: 620, y: 40 });
    },
    { zoneId: zone!.id, first, second },
  );
}
const centreOf = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("a hand-off drawn from one agent's handle to another opens its Edge rules, delivers its final message on Stop along the edge, and a manual one waits to be sent", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    await spawnAgent(window, 'monorepo', 'Review the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    const reviewer = tile(window).filter({ hasText: 'Review the code' });
    // Each has finished its first turn and sits at its prompt.
    for (const agent of [coder, reviewer]) await expect(agent).toHaveAttribute('data-state', 'waiting');
    const all = await agents(window);
    const coderAgent = all.find((agent) => agent.name === 'Write the code')!;
    const reviewerAgent = all.find((agent) => agent.name === 'Review the code')!;
    await spaceApart(window, coderAgent.sessionId, reviewerAgent.sessionId);

    // Dragged from the coder's round handle over the reviewer, the line says ⌥ makes it a hand-off; with ⌥ held it
    // says what it carries and who to, only agents' tiles are targets, and Esc calls it off.
    const handle = window.locator(`.react-flow__node[data-id="agent:${coderAgent.sessionId}"] > .connector-handle[data-side="right"]`);
    await coder.hover();
    await expect(handle).toHaveCSS('opacity', '1');
    const from = await centreOf(handle);
    const to = await centreOf(reviewer);
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 12 });
    await expect(window.getByTestId('flow-drop-hint')).toHaveText('Hold ⌥ to hand off');
    await window.keyboard.down('Alt');
    await expect(window.getByTestId('flow-drop-hint')).toHaveText('Hand off to Review the code');
    await expect(window.getByTestId('flow-drag-payload')).toHaveText('▶ final message');
    await expect(window.locator('.board-drawing-flow')).toHaveCount(1);
    // Over empty board, ⌥ or not, it would make an arrow and a note, so it looks like an arrow's line.
    await window.mouse.move(to.x, to.y + 220, { steps: 4 });
    await expect(window.getByTestId('flow-drag-payload')).toHaveCount(0);
    await expect(window.locator('.flow-connection-ghost')).toHaveCount(0);
    await window.mouse.move(to.x, to.y, { steps: 4 });
    await expect(window.getByTestId('flow-drag-payload')).toHaveCount(1);
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await window.keyboard.up('Alt');
    await expect(window.locator('.board-drawing-flow')).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);
    expect(await connectors(window)).toEqual([]);

    // Let go on the other tile, the chooser asks; H makes it a hand-off, an auto edge, selected, its Edge rules open.
    await coder.hover();
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 12 });
    await window.mouse.up();
    await expect(window.getByTestId('handoff-chooser')).toBeVisible();
    await window.keyboard.press('h');
    await expect(window.getByTestId('handoff-chooser')).toHaveCount(0);
    // H was the chooser's, not the board's Hand tool.
    await expect(window.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // One rail, and on it, at the coder's end, a ghost of what comes next.
    const edge = window.getByTestId('flow-edge');
    const token = window.getByTestId('rail-token');
    await expect(edge).toHaveCount(1);
    await expect(token).toHaveAttribute('data-state', 'next');
    await expect(token).toContainText('final message');
    await expect(token.getByTestId('rail-token-note')).toHaveText('when done');
    expect(await flowEdges(window)).toEqual([
      expect.objectContaining({ from: coderAgent.sessionId, to: reviewerAgent.sessionId, fromSide: 'right', toSide: 'auto' }),
    ]);
    // The arrow drawn meanwhile became it.
    await expect.poll(() => connectors(window)).toEqual([]);
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('Write the code');
    await expect(rules).toContainText('Review the code');
    await expect(rules.getByText('new', { exact: true })).toBeVisible();
    // Its four sections open with what they do.
    await expect(rules.getByRole('group', { name: 'Trigger' }).getByRole('button', { name: 'When it hands off' })).toHaveAttribute('aria-pressed', 'true');
    await expect(rules.locator('.edge-rules-summary')).toHaveText([
      'Sends by itself when Write the code hands off',
      "Sends Write the code's final message",
      'Nothing to wait for',
    ]);
    await expect(rules.locator('.ui-section-label > span:first-child')).toHaveText(['When', 'What', 'Only if', 'History']);

    // The coder's next turn ends: its final message goes to the reviewer as its next message, shown along the edge.
    await recordStates(window);
    await answer(window, coderAgent.sessionId, 'Ship it');
    await expect(token).toHaveAttribute('data-state', 'sending');
    await expect(reviewer.getByText('receiving…').first()).toBeVisible();
    await expect
      .poll(async () => (await agents(window)).find((agent) => agent.sessionId === reviewerAgent.sessionId)?.lastMessage)
      .toBe('Done: Hand-off from Write the code (its final message): Done: Ship it..');
    expect(await recordedStates(window)).toContain('handing-off');
    await expect(token).toHaveAttribute('data-state', 'delivered');
    await expect(token.getByTestId('rail-token-note')).toHaveText(/^delivered \d\d:\d\d$/);
    await expect(rules).toContainText('Sent final message');
    await expect(rules).toContainText('fired 1 time');

    // Made manual in the panel, it waits for Send, which delivers the last final message again.
    await rules.getByRole('group', { name: 'Trigger' }).getByRole('button', { name: 'I press Send' }).click();
    await expect(rules.locator('.edge-rules-summary').first()).toHaveText('Sends when you press Send');
    await expect.poll(async () => (await flowEdges(window))[0]?.trigger).toBe('manual');
    const [sent] = await flowEdges(window);
    await rules.getByRole('button', { name: 'Send now' }).click();
    await expect.poll(async () => (await flowEdges(window))[0]!.lastDelivery?.at).not.toBe(sent!.lastDelivery!.at);
    expect((await flowEdges(window))[0]!.lastDelivery).toMatchObject({ delivered: true });

    // Closing the panel leaves the edge; clicked again, the same panel opens on it, without "new".
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(rules).toHaveCount(0);
    await token.locator('.rail-token-open').click();
    await expect(rules).toBeVisible();
    await expect(rules.getByText('new', { exact: true })).toHaveCount(0);

    // Selected, it deletes from the keyboard; another, from the panel.
    await window.keyboard.press('Delete');
    await expect(edge).toHaveCount(0);
    await expect(rules).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);
    await join(window, coderAgent.sessionId, reviewerAgent.sessionId);
    await token.locator('.rail-token-open').click();
    await rules.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(edge).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);

    // An edge goes with its agent, and its open Edge rules close.
    await join(window, coderAgent.sessionId, reviewerAgent.sessionId);
    await token.locator('.rail-token-open').click();
    await expect(rules).toBeVisible();
    await deleteAgent(window, reviewerAgent.sessionId);
    await expect(rules).toHaveCount(0);
    await expect(edge).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Edge rules carry a file from the agent\'s worktree, hold a hand-off until a condition passes, pause, queue, preview it, and undo', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  // Held hand-offs are checked again every fifth of a second, not every minute.
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_FLOW_RECHECK_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the plan');
    await spawnAgent(window, 'monorepo', 'Build it');
    for (const name of ['Write the plan', 'Build it']) await expect(tile(window).filter({ hasText: name })).toHaveAttribute('data-state', 'waiting');
    const all = await agents(window);
    const planner = all.find((agent) => agent.name === 'Write the plan')!;
    const builder = all.find((agent) => agent.name === 'Build it')!;
    await spaceApart(window, planner.sessionId, builder.sessionId);
    await join(window, planner.sessionId, builder.sessionId);
    const edge = window.getByTestId('flow-edge');
    const token = window.getByTestId('rail-token');
    await token.locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    // Its final message, previewed: what the planner's first turn ended with.
    await expect(rules.getByTestId('edge-rules-preview')).toHaveText('All tests pass.');

    // A handover.md payload, from a file the planner wrote: the label names it, and the preview shows it.
    await rules.getByRole('group', { name: 'Payload' }).getByRole('button', { name: 'File' }).click();
    const file = rules.getByRole('textbox', { name: "File in Write the plan's worktree" });
    await expect(file).toHaveValue('handover.md');
    writeFileSync(joinPath(planner.worktree, 'plan.md'), '# Plan\n\n1. Add zoneId.\n');
    await file.fill('plan.md');
    await file.press('Enter');
    await expect(token).toContainText('plan.md');
    await expect(rules.getByTestId('edge-rules-preview')).toHaveText('# Plan\n\n1. Add zoneId.\n');
    await expect(rules).toContainText('plan.md · 3 lines');

    // A custom script that fails holds the planner's next hand-off, on the edge and in the panel.
    await rules.getByRole('button', { name: 'Add condition' }).click();
    await window.getByRole('menuitem', { name: /Custom script/ }).click();
    await rules.getByRole('textbox', { name: 'Script' }).fill('test -f ready');
    await rules.getByRole('button', { name: 'Add', exact: true }).click();
    // It runs nothing until approved, exactly as shown, in the panel under its condition.
    const approval = rules.getByTestId('approve-command');
    await expect(rules.locator('.edge-rules-condition-check')).toHaveText('needs approval');
    await expect(approval).toContainText('test -f ready');
    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toHaveCount(0);
    await expect(rules.getByText('Script passes: test -f ready')).toBeVisible();
    await expect(rules).toContainText('Approved: test -f ready');
    await answer(window, planner.sessionId, 'Plan it');
    await expect(token).toHaveAttribute('data-state', 'held');
    await expect(token.getByTestId('rail-token-note')).toHaveText('held until script passes');
    await expect(token).toContainText('0/1');
    await expect(rules).toContainText('Held: exited 1');
    await expect(rules.getByTestId('edge-rules-kept')).toHaveText('Holding plan.md, a copy keptDrop');
    expect((await flowEdges(window))[0]).toMatchObject({ payload: 'handover', path: 'plan.md', held: { reason: 'exited 1' } });

    // Paused, it keeps holding it, even once the script passes; resumed, it releases it by itself.
    await rules.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(token.getByTestId('rail-token-note')).toHaveText('paused · held until script passes');
    // The note is the panel's at once; the daemon's pause is what holds it.
    await expect.poll(async () => (await flowEdges(window))[0]?.paused).toBe(true);
    writeFileSync(joinPath(planner.worktree, 'ready'), '');
    await window.waitForTimeout(600);
    expect((await flowEdges(window))[0]).toMatchObject({ paused: true, deliveries: 0 });
    await rules.getByRole('button', { name: 'Resume', exact: true }).click();
    const builderMessage = async () => (await agents(window)).find((agent) => agent.sessionId === builder.sessionId)?.lastMessage;
    await expect.poll(builderMessage).toBe('Done: Hand-off from Write the plan (its plan.md): # Plan 1. Add zoneId..');
    await expect(token).toHaveAttribute('data-state', 'delivered');
    await expect(rules).toContainText('Released: every condition passed');
    await expect(rules).toContainText('Sent plan.md (23 B) to Build it');

    // Send now sends whatever the conditions say; Wait for its turn is kept with the edge.
    await rules.getByRole('button', { name: 'Remove Script passes: test -f ready condition' }).click();
    await rules.getByRole('button', { name: 'Add condition' }).click();
    await window.getByRole('menuitem', { name: /Custom script/ }).click();
    await rules.getByRole('textbox', { name: 'Script' }).fill('false');
    await rules.getByRole('button', { name: 'Add', exact: true }).click();
    // Not approved, it waits with an Approve button.
    await expect(rules.getByTestId('approve-command')).toContainText('false');
    await expect(rules.locator('.edge-rules-condition').getByRole('button', { name: 'Approve' })).toBeVisible();
    await rules.getByRole('button', { name: 'Wait for its turn' }).click();
    await rules.getByRole('button', { name: 'Send now' }).click();
    await expect(rules).toContainText('fired 2 times');
    expect((await flowEdges(window))[0]).toMatchObject({ deliverAs: 'queue', conditions: [{ kind: 'script', command: 'false' }] });

    // Deleted, undo puts it back with its rules; redo deletes it again.
    await rules.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(edge).toHaveCount(0);
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect(edge).toHaveCount(1);
    await expect(token).toContainText('plan.md');
    expect((await flowEdges(window))[0]).toMatchObject({ payload: 'handover', path: 'plan.md', deliverAs: 'queue', conditions: [{ kind: 'script', command: 'false' }] });
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect(edge).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two agents joined both ways draw one rail: the latest document rides it, Send slides it across and delivers, and the Edge rules open per direction', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    await spawnAgent(window, 'monorepo', 'Review the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    const reviewer = tile(window).filter({ hasText: 'Review the code' });
    for (const agent of [coder, reviewer]) await expect(agent).toHaveAttribute('data-state', 'waiting');
    const all = await agents(window);
    const coderAgent = all.find((agent) => agent.name === 'Write the code')!;
    const reviewerAgent = all.find((agent) => agent.name === 'Review the code')!;
    await spaceApart(window, coderAgent.sessionId, reviewerAgent.sessionId);
    // The coder's final message goes to the reviewer by itself; the reviewer's review.md goes back when sent.
    writeFileSync(joinPath(reviewerAgent.worktree, 'review.md'), '# Review\n\n1. Rename it.\n');
    const [handover, review] = await window.evaluate(
      async ([coderId, reviewerId]) => [
        await globalThis.window.agentBoard.flowEdges.create({ from: coderId!, to: reviewerId! }),
        await globalThis.window.agentBoard.flowEdges.create({ from: reviewerId!, to: coderId!, trigger: 'manual', payload: 'handover', path: 'review.md' }),
      ],
      [coderAgent.sessionId, reviewerAgent.sessionId],
    );

    // One rail, no arrowheads, and one token: the review, waiting for Send at the reviewer's end, since it is done.
    const edge = window.getByTestId('flow-edge');
    const token = window.getByTestId('rail-token');
    await expect(edge).toHaveCount(1);
    await expect(edge).toHaveAttribute('data-pair', 'true');
    await expect(edge).not.toHaveAttribute('marker-end');
    await expect(token).toHaveCount(1);
    await expect(token).toHaveAttribute('data-state', 'waiting');
    await expect(token).toContainText('review.md');
    /** Whose tile the token is nearer: it sits at the end of whoever has it. */
    const nearer = async () => {
      const tileOf = (sessionId: string) => window.locator(`[data-testid="agent-tile"][data-session-id="${sessionId}"]`);
      const [chip, coderBox, reviewerBox] = await Promise.all([
        token.locator('.rail-token-chip').boundingBox(),
        tileOf(coderAgent.sessionId).boundingBox(),
        tileOf(reviewerAgent.sessionId).boundingBox(),
      ]);
      const middle = chip!.x + chip!.width / 2;
      return middle - (coderBox!.x + coderBox!.width) < reviewerBox!.x - middle ? 'coder' : 'reviewer';
    };
    expect(await nearer()).toBe('reviewer');

    // Send: it goes along the rail to the coder, and is delivered there, its first round.
    await token.getByTestId('rail-token-send').click();
    await expect(token).toHaveAttribute('data-state', 'sending');
    await expect.poll(async () => (await flowEdges(window)).find((each) => each.id === review.id)?.lastDelivery).toMatchObject({ delivered: true });
    await expect.poll(nearer).toBe('coder');
    // The coder's turn on it ends, and its final message goes back by itself; the reviewer done again, the next review
    // waits for Send, its second round.
    await expect.poll(async () => (await flowEdges(window)).find((each) => each.id === handover.id)?.deliveries, { timeout: 15_000 }).toBe(1);
    await expect(token).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 });
    await expect(token).toContainText('R2');
    expect(await nearer()).toBe('reviewer');

    // Its token opens the Edge rules on the review; the switch shows the other direction's.
    await token.locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules.locator('.edge-rules-ends > span').first()).toHaveText('Review the code');
    const directions = rules.getByRole('group', { name: 'Direction' });
    await expect(directions.getByRole('button', { name: 'Review the code → Write the code' })).toHaveAttribute('aria-pressed', 'true');
    await directions.getByRole('button', { name: 'Write the code → Review the code' }).click();
    await expect(rules.locator('.edge-rules-ends > span').first()).toHaveText('Write the code');
    await expect(rules.locator('.edge-rules-summary').first()).toHaveText('Sends by itself when Write the code hands off');
    // The rail stays selected the while, and closing the rules leaves both edges.
    await expect(window.locator('.react-flow__edge.selected')).toHaveCount(1);
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(rules).toHaveCount(0);
    expect(await flowEdges(window)).toHaveLength(2);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
