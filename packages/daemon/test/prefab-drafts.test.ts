// Prefab drafts: any agent drafts one, checked as an imported file is; the user opens, keeps or deletes it, and a
// drafter started only to draft closes as its draft opens.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { prefabFile } from '../src/crew-prefabs.ts';
import { draftingPrompt } from '../src/prefab-drafts.ts';
import { MAX_DRAFT_ASSUMPTIONS, MAX_PREFAB_DRAFTS, prefabDraftLink, prefabDraftOfLink, RPC_ERROR, type CrewPrefab, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function draftDaemon(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, dataDir, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof draftDaemon>>;

/** The board token an agent's terminal shows once it is asked for it, as a connection that speaks for the agent. */
async function speakAs(setup: Setup, sessionId: string) {
  await setup.client.call('session.attach', { sessionId });
  await setup.recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(sessionId))![1]!;
  const connection = await connectTestClient(setup.daemon);
  await connection.call('board.identify', { token });
  return { token, connection };
}

/** An agent the user starts in the zone, connected as it. */
async function agentOnBoard(setup: Setup) {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...SIZE });
  return { agent, ...(await speakAs(setup, agent.sessionId)) };
}

const prompts = (setup: Setup, sessionId: string) =>
  setup.recorder.events
    .filter((e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit')
    .map((e) => String(e.payload.prompt));

const pair = (fields: Partial<CrewPrefab> = {}): CrewPrefab => ({
  name: 'Pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  roundLimit: 2,
  onBoard: 'card',
  members: [
    { id: 'impl', role: 'implementer', name: null, harness: 'claude', model: 'opus', effort: null, template: null, starts: 'prompt', subagents: [] },
    { id: 'review', role: 'reviewer', name: null, harness: 'codex', model: null, effort: null, template: null, starts: 'handoff', subagents: [] },
  ],
  ...fields,
});

describe('prefab drafts', () => {
  it('takes a draft from any agent, checked and written out as the library keeps a file, and tells the app', async () => {
    const setup = await draftDaemon();
    const { agent, token, connection } = await agentOnBoard(setup);
    const draft = await connection.call('board.draftPrefab', {
      token,
      text: JSON.stringify(JSON.parse(prefabFile(pair()))),
      assumptions: ['Two rounds of review  \n at most', { text: 'The reviewer runs on Codex', about: 'review' }],
    });
    expect(draft).toMatchObject({
      id: expect.stringMatching(/^draft:/),
      prefab: { name: 'Pair', members: [{ id: 'impl' }, { id: 'review' }] },
      assumptions: [
        { text: 'Two rounds of review at most', about: null },
        { text: 'The reviewer runs on Codex', about: 'review' },
      ],
      drafter: { tileId: agent.sessionId, name: agent.name },
      closesDrafter: false,
    });
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'prefabDraft.added' && e.draft.id === draft.id);
    // A draft is not the library's: nothing is saved until the user saves it.
    expect((await setup.client.call('orchestrator.prefabs', {})).prefabs.map((each) => each.name)).not.toContain('Pair');
    expect((await setup.client.call('prefabDraft.list', {})).drafts).toEqual([draft]);
  });

  it('refuses a file the import refuses, and assumptions about nothing in it', async () => {
    const setup = await draftDaemon();
    const { token, connection } = await agentOnBoard(setup);
    await expect(connection.call('board.draftPrefab', { token, text: '{"version": 1}' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(connection.call('board.draftPrefab', { token, text: 'x'.repeat(1_000_001) })).rejects.toThrow(/too big/);
    const text = prefabFile(pair());
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: [{ text: 'A guess', about: 'nobody' }] })).rejects.toThrow(/members, inputs or loop gates/);
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: ['hidden\u202etext'] })).rejects.toThrow(/control characters/);
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: ['   '] })).rejects.toThrow(/needs some text/);
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: [`${'a'.repeat(301)}`] })).rejects.toThrow(/at most 300/);
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: Array(MAX_DRAFT_ASSUMPTIONS + 1).fill('a') })).rejects.toThrow(/at most/);
    await expect(connection.call('board.draftPrefab', { token, text, assumptions: 'a line' as never })).rejects.toThrow(/must be a list/);
    expect((await setup.client.call('prefabDraft.list', {})).drafts).toEqual([]);
  });

  it('keeps no more drafts than the user can get through', async () => {
    const setup = await draftDaemon();
    const { token, connection } = await agentOnBoard(setup);
    const text = prefabFile(pair());
    for (let i = 0; i < MAX_PREFAB_DRAFTS; i++) await connection.call('board.draftPrefab', { token, text });
    await expect(connection.call('board.draftPrefab', { token, text })).rejects.toThrow(/Settings › Prefabs › Drafts/);
  });

  it('keeps a draft across a restart until it is deleted, opened or not', async () => {
    const setup = await draftDaemon();
    const { token, connection } = await agentOnBoard(setup);
    const draft = await connection.call('board.draftPrefab', { token, text: prefabFile(pair()) });
    expect(await setup.client.call('prefabDraft.open', { id: draft.id })).toEqual(draft);

    await setup.daemon.stop();
    const again = await draftDaemon(setup.dataDir);
    expect((await again.client.call('prefabDraft.list', {})).drafts).toEqual([draft]);
    const recorder = recordEvents(again.client);
    expect(await again.client.call('prefabDraft.remove', { id: draft.id })).toBeNull();
    await recorder.waitFor((e): e is DaemonEvent => e.type === 'prefabDraft.removed' && e.id === draft.id);
    expect((await again.client.call('prefabDraft.list', {})).drafts).toEqual([]);
    await expect(again.client.call('prefabDraft.open', { id: draft.id })).rejects.toThrow(/saved or deleted/);
    await expect(again.client.call('prefabDraft.remove', { id: draft.id })).rejects.toThrow(/saved or deleted/);
  });

  it("leaves opening, listing, deleting and asking for drafts to the user", async () => {
    const setup = await draftDaemon();
    const { token, connection } = await agentOnBoard(setup);
    const draft = await connection.call('board.draftPrefab', { token, text: prefabFile(pair()) });
    for (const [method, params] of [
      ['prefabDraft.list', {}],
      ['prefabDraft.open', { id: draft.id }],
      ['prefabDraft.remove', { id: draft.id }],
      ['prefabDraft.describe', { description: 'A crew', zoneId: setup.zone.id }],
    ] as const) {
      await expect(connection.call(method, { token, ...params } as never)).rejects.toThrow(/is not open to/);
    }
    expect((await setup.client.call('prefabDraft.list', {})).drafts).toHaveLength(1);
  });

  it('starts a new drafter on the description, which closes once its draft is opened', async () => {
    const setup = await draftDaemon();
    const asked = await setup.client.call('prefabDraft.describe', { description: 'Print your board identity', zoneId: setup.zone.id });
    expect(asked).toMatchObject({ started: true });
    const { token, connection } = await speakAs(setup, asked.sessionId);
    const started = (await setup.client.call('agent.list')).find((each) => each.sessionId === asked.sessionId)!;
    expect(started).toMatchObject({ harness: 'claude', model: 'sonnet', name: asked.name });
    expect(prompts(setup, asked.sessionId)[0]).toBe(draftingPrompt('Print your board identity', true));

    const draft = await connection.call('board.draftPrefab', { token, text: prefabFile(pair()) });
    expect(draft.closesDrafter).toBe(true);
    expect(await setup.client.call('prefabDraft.open', { id: draft.id })).toEqual({ ...draft, closesDrafter: false });
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === asked.sessionId);
    // Once: the draft stays, and opening it again closes nothing.
    expect(await setup.client.call('prefabDraft.open', { id: draft.id })).toEqual({ ...draft, closesDrafter: false });
  });

  it('closes a new drafter whose draft the user deletes unopened', async () => {
    const setup = await draftDaemon();
    const asked = await setup.client.call('prefabDraft.describe', { description: 'Print your board identity', zoneId: setup.zone.id });
    const { token, connection } = await speakAs(setup, asked.sessionId);
    const draft = await connection.call('board.draftPrefab', { token, text: prefabFile(pair()) });
    expect(await setup.client.call('prefabDraft.remove', { id: draft.id })).toBeNull();
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === asked.sessionId);
  });

  it('asks an agent on the board to draft, which carries on after', async () => {
    const setup = await draftDaemon();
    const { agent, token, connection } = await agentOnBoard(setup);
    const asked = await setup.client.call('prefabDraft.describe', { description: 'A builder and a reviewer', drafter: agent.sessionId });
    expect(asked).toEqual({ sessionId: agent.sessionId, name: agent.name, started: false });
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'UserPromptSubmit' && String(e.payload.prompt).includes('A builder and a reviewer'));
    expect(prompts(setup, agent.sessionId).at(-1)).toContain('Then carry on with your own work.');

    const draft = await connection.call('board.draftPrefab', { token, text: prefabFile(pair()) });
    expect(draft.closesDrafter).toBe(false);
    await setup.client.call('prefabDraft.open', { id: draft.id });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.endedAt).toBeNull();
  });

  it('refuses a description with nothing in it, a drafter not on the board, and a new drafter with no zone', async () => {
    const setup = await draftDaemon();
    await expect(setup.client.call('prefabDraft.describe', { description: '  ', zoneId: setup.zone.id })).rejects.toThrow(/say what the crew/);
    await expect(setup.client.call('prefabDraft.describe', { description: 'A crew', drafter: 'nobody' })).rejects.toThrow(/not on the board/);
    await expect(setup.client.call('prefabDraft.describe', { description: 'A crew' })).rejects.toThrow(/name the zone/);
    expect(await setup.client.call('agent.list')).toEqual([]);
  });

  it('takes a draft file from `prefab draft` and the prefab_draft tool, read as an import reads it', async () => {
    const setup = await draftDaemon();
    const { token } = await agentOnBoard(setup);
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token };
    const run = async (...args: string[]) => {
      let out = '';
      let err = '';
      const code = await runBoardCommand('prefab', args, { out: (text) => (out += text), err: (text) => (err += text), env });
      return { code, out, err };
    };
    const file = join(tempDataDir(), 'pair.crew.json');
    writeFileSync(file, prefabFile(pair()));

    // A line that starts with an id in brackets is about that member.
    const first = await run('draft', file, '--assumed', 'Two rounds at most', '--assumed', '[review] Codex reviews');
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining('Drafted Pair for the user') });
    // Its reply carries the link that opens it, for the drafter to give the user.
    const drafted = (await setup.client.call('prefabDraft.list', {})).drafts.at(-1)!;
    expect(first.out).toContain(`opens it: agent-board://draft/${drafted.id.slice('draft:'.length)}`);
    expect(prefabDraftOfLink(prefabDraftLink(drafted.id))).toBe(drafted.id);
    expect((await setup.client.call('prefabDraft.list', {})).drafts.at(-1)?.assumptions).toEqual([
      { text: 'Two rounds at most', about: null },
      { text: 'Codex reviews', about: 'review' },
    ]);
    expect(await run('draft', file, '--assumed', '[nobody] Codex reviews')).toMatchObject({ code: 1, err: expect.stringContaining('by its id: not "nobody"') });
    expect(await run('ls', '--assumed', 'x')).toMatchObject({ code: 2, err: expect.stringContaining('--assumed is only for `prefab draft`') });
    expect(await run('draft')).toMatchObject({ err: expect.stringContaining('give one .crew.json file') });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(prefabFile(pair())), prompt: 'Ship it' }));
    expect(await run('draft', file)).toMatchObject({ code: 1, err: expect.stringContaining('a crew prefab holds no prompt') });
    // The user, with no agent's token, has the library itself: a draft is for them, not from them.
    expect(await runBoardCommand('prefab', ['draft', file], { out: () => {}, err: () => {}, env: { ...env, AGENT_BOARD_IDENTITY: '' } })).not.toBe(0);

    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    writeFileSync(file, prefabFile(pair({ name: 'Pair two' })));
    expect(await mcp.callTool('prefab_draft', { file, assumed: ['One round', '[impl] Works on its own branch'] })).toMatchObject({
      isError: false,
      text: expect.stringContaining('[impl] Works on its own branch'),
    });
    expect(await mcp.callTool('prefab_draft', { file: 'pair.crew.json' })).toMatchObject({ isError: true, text: expect.stringContaining('absolute path') });
    expect((await setup.client.call('prefabDraft.list', {})).drafts.map((each) => each.prefab.name)).toEqual(['Pair', 'Pair two']);
  });
});
