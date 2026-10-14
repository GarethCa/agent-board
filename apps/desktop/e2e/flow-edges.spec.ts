import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { FlowEdge } from '@agent-board/daemon/protocol';
import { agents, launch, recordedStates, recordStates, spawnAgent, tile } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const flowEdges = (page: Page): Promise<FlowEdge[]> => page.evaluate(() => window.agentBoard.flowEdges.list());
const answer = (page: Page, sessionId: string, text: string): Promise<void> =>
  page.evaluate(([id, typed]) => window.agentBoard.agents.answer(id!, typed!), [sessionId, text]);
const deleteAgent = (page: Page, sessionId: string) => page.evaluate((id) => window.agentBoard.agents.delete(id, true), sessionId);
const join = (page: Page, from: string, to: string): Promise<FlowEdge> =>
  page.evaluate(([a, b]) => window.agentBoard.flowEdges.create({ from: a!, to: b! }), [from, to]);
const centreOf = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("an edge drawn from one agent's flow port to another opens its Edge rules, delivers its final message on Stop along the edge, and a manual one waits to be sent", async () => {
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

    // The filled square out port shows on hover; dragging it lights only agent tiles as targets, and Esc cancels.
    const port = window.locator(`.react-flow__node[data-id="agent:${coderAgent.sessionId}"]`).getByTestId('flow-port-out');
    await coder.hover();
    await expect(port).toHaveCSS('opacity', '1');
    const from = await centreOf(port);
    const to = await centreOf(reviewer);
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 12 });
    await expect(window.getByTestId('flow-drop-hint')).toHaveText('Release to connect to Review the code');
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(window.locator('.board-drawing-flow')).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);

    // Let go on the other tile, it joins them with an auto edge, selected, and the Edge rules panel opens on it.
    await coder.hover();
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 12 });
    await window.mouse.up();
    const edge = window.getByTestId('flow-edge');
    await expect(edge).toHaveCount(1);
    await expect(edge).toHaveAttribute('data-trigger', 'auto');
    await expect(edge).toContainText('final message');
    expect(await flowEdges(window)).toEqual([expect.objectContaining({ from: coderAgent.sessionId, to: reviewerAgent.sessionId })]);
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('Write the code');
    await expect(rules).toContainText('Review the code');
    await expect(rules.getByText('new', { exact: true })).toBeVisible();
    await expect(rules.getByRole('radio', { name: 'Auto when Write the code is done' })).toBeChecked();

    // The coder's next turn ends: its final message goes to the reviewer as its next message, shown along the edge.
    await recordStates(window);
    await answer(window, coderAgent.sessionId, 'Ship it');
    await expect(edge).toHaveAttribute('data-live', 'true');
    await expect(window.getByTestId('flow-payload')).toHaveCount(1);
    await expect(reviewer.getByText('receiving…').first()).toBeVisible();
    await expect
      .poll(async () => (await agents(window)).find((agent) => agent.sessionId === reviewerAgent.sessionId)?.lastMessage)
      .toBe('Done: Hand-off from Write the code (its final message): Done: Ship it..');
    expect(await recordedStates(window)).toContain('handing-off');
    await expect(edge).not.toHaveAttribute('data-live', 'true');
    await expect(rules).toContainText('Sent final message');
    await expect(rules).toContainText('fired 1 time');

    // Made manual in the panel, it waits for Send, which delivers the last final message again.
    await rules.getByRole('radio', { name: 'Manual, with a Send button' }).check();
    await expect(edge).toHaveAttribute('data-trigger', 'manual');
    const [sent] = await flowEdges(window);
    await edge.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await flowEdges(window))[0]!.lastDelivery?.at).not.toBe(sent!.lastDelivery!.at);
    expect((await flowEdges(window))[0]!.lastDelivery).toMatchObject({ delivered: true });

    // Closing the panel leaves the edge; clicked again, the same panel opens on it, without "new".
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(rules).toHaveCount(0);
    await edge.locator('.flow-edge-pill').click({ force: true });
    await expect(rules).toBeVisible();
    await expect(rules.getByText('new', { exact: true })).toHaveCount(0);

    // Selected, it deletes from the keyboard; another, from the panel.
    await window.keyboard.press('Delete');
    await expect(edge).toHaveCount(0);
    await expect(rules).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);
    await join(window, coderAgent.sessionId, reviewerAgent.sessionId);
    await edge.locator('.flow-edge-pill').click({ force: true });
    await rules.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(edge).toHaveCount(0);
    expect(await flowEdges(window)).toEqual([]);

    // An edge goes with its agent, and its open Edge rules close.
    await join(window, coderAgent.sessionId, reviewerAgent.sessionId);
    await edge.locator('.flow-edge-pill').click({ force: true });
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
    await join(window, planner.sessionId, builder.sessionId);
    const edge = window.getByTestId('flow-edge');
    await edge.locator('.flow-edge-pill').click({ force: true });
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    // Its final message, previewed: what the planner's first turn ended with.
    await expect(rules.getByTestId('edge-rules-preview')).toHaveText('All tests pass.');

    // A handover.md payload, from a file the planner wrote: the label names it, and the preview shows it.
    await rules.getByRole('group', { name: 'Payload' }).getByRole('button', { name: 'handover.md' }).click();
    const file = rules.getByRole('textbox', { name: "File in Write the plan's worktree" });
    await expect(file).toHaveValue('handover.md');
    writeFileSync(joinPath(planner.worktree, 'plan.md'), '# Plan\n\n1. Add zoneId.\n');
    await file.fill('plan.md');
    await file.press('Enter');
    await expect(edge).toContainText('plan.md');
    await expect(rules.getByTestId('edge-rules-preview')).toHaveText('# Plan\n\n1. Add zoneId.\n');
    await expect(rules).toContainText('plan.md · 3 lines');

    // A custom script that fails holds the planner's next hand-off, on the edge and in the panel.
    await rules.getByRole('button', { name: 'Add condition' }).click();
    await window.getByRole('menuitem', { name: /Custom script/ }).click();
    await rules.getByRole('textbox', { name: 'Script' }).fill('test -f ready');
    await rules.getByRole('button', { name: 'Add', exact: true }).click();
    // It runs nothing until approved, exactly as shown. The dialog is modal: the panel is reached again once it closes.
    const approval = window.getByRole('alertdialog', { name: 'Run this command?' });
    await expect(approval).toContainText('test -f ready');
    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toHaveCount(0);
    await expect(rules.getByText('Script passes: test -f ready')).toBeVisible();
    await expect(rules).toContainText('Approved: test -f ready');
    await answer(window, planner.sessionId, 'Plan it');
    await expect(window.getByTestId('flow-edge-note')).toHaveText('held until script passes');
    await expect(rules).toContainText('Held: exited 1');
    await expect(rules.getByTestId('edge-rules-kept')).toHaveText('Holding plan.md, a copy keptDrop');
    expect((await flowEdges(window))[0]).toMatchObject({ payload: 'handover', path: 'plan.md', held: { reason: 'exited 1' } });

    // Paused, it keeps holding it, even once the script passes; resumed, it releases it by itself.
    await rules.getByRole('button', { name: 'Pause edge' }).click();
    await expect(window.getByTestId('flow-edge-note')).toHaveText('paused');
    // The note is the panel's at once; the daemon's pause is what holds it.
    await expect.poll(async () => (await flowEdges(window))[0]?.paused).toBe(true);
    writeFileSync(joinPath(planner.worktree, 'ready'), '');
    await window.waitForTimeout(600);
    expect((await flowEdges(window))[0]).toMatchObject({ paused: true, deliveries: 0 });
    await rules.getByRole('button', { name: 'Resume edge' }).click();
    const builderMessage = async () => (await agents(window)).find((agent) => agent.sessionId === builder.sessionId)?.lastMessage;
    await expect.poll(builderMessage).toBe('Done: Hand-off from Write the plan (its plan.md): # Plan 1. Add zoneId..');
    await expect(window.getByTestId('flow-edge-note')).toHaveCount(0);
    await expect(rules).toContainText('Released: every condition passed');
    await expect(rules).toContainText('Sent plan.md (23 B) to Build it');

    // Send now sends whatever the conditions say; Queue after turn is kept with the edge.
    await rules.getByRole('button', { name: 'Remove Script passes: test -f ready condition' }).click();
    await rules.getByRole('button', { name: 'Add condition' }).click();
    await window.getByRole('menuitem', { name: /Custom script/ }).click();
    await rules.getByRole('textbox', { name: 'Script' }).fill('false');
    await rules.getByRole('button', { name: 'Add', exact: true }).click();
    // Not approved now, it waits with an Approve button.
    const notNow = window.getByRole('alertdialog', { name: 'Run this command?' });
    await expect(notNow).toContainText('false');
    await notNow.getByRole('button', { name: 'Not now' }).click();
    await expect(notNow).toHaveCount(0);
    await expect(rules.locator('.edge-rules-condition').getByRole('button', { name: 'Approve' })).toBeVisible();
    await rules.getByRole('radio', { name: 'Queue after turn' }).check();
    await rules.getByRole('button', { name: 'Send now' }).click();
    await expect(rules).toContainText('fired 2 times');
    expect((await flowEdges(window))[0]).toMatchObject({ deliverAs: 'queue', conditions: [{ kind: 'script', command: 'false' }] });

    // Deleted, undo puts it back with its rules; redo deletes it again.
    await rules.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(edge).toHaveCount(0);
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect(edge).toHaveCount(1);
    await expect(edge).toContainText('plan.md');
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
