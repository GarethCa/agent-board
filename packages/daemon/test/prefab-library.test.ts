// The app's crew prefab library: one for every board, changed only by the user or a board-scope orchestrator, and a
// crew started from a prefab as an orchestrator's agent is.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { prefabFile } from '../src/crew-prefabs.ts';
import { BOARD_ERROR, RPC_ERROR, type CrewPrefab, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function prefabDaemon(dataDir = tempDataDir()) {
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

type Setup = Awaited<ReturnType<typeof prefabDaemon>>;

/** An agent the user lets orchestrate in `scope`, connected as it with its board token. */
async function lead(setup: Setup, scope: 'zone' | 'repo' | 'board') {
  const { daemon, client, recorder } = setup;
  const agent = await client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', orchestrate: scope, ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

async function firstPrompt(setup: Setup, sessionId: string): Promise<string> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit',
  );
  return String(event.payload.prompt);
}

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

describe('the crew prefab library', () => {
  it('lists the built-ins, then what is saved, and keeps it across a restart', async () => {
    const setup = await prefabDaemon();
    expect((await setup.client.call('orchestrator.prefabs', {})).prefabs.map((each) => [each.name, each.builtIn])).toEqual([
      ['Solo agent', true],
      ['Implementer + reviewer', true],
      ['Implementer + code + design reviewers', true],
      ['Spike + reviewer', true],
      ['Lead and crew', true],
    ]);

    const saved = await setup.client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });
    expect(saved).toEqual({ ...pair(), builtIn: false, editedAt: expect.any(String) });

    await setup.daemon.stop();
    const again = await prefabDaemon(setup.dataDir);
    expect((await again.client.call('orchestrator.prefabs', {})).prefabs.at(-1)).toEqual(saved);
  });

  it('refuses a name it has, in any case, unless replaced; and never a built-in’s', async () => {
    const { client } = await prefabDaemon();
    await client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });

    await expect(client.call('orchestrator.savePrefab', { text: prefabFile(pair({ name: 'PAIR' })) })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('has a crew prefab named Pair already'),
    });
    const replaced = await client.call('orchestrator.savePrefab', { text: prefabFile(pair({ name: 'PAIR', roundLimit: 5 })), replace: true });
    expect(replaced).toMatchObject({ name: 'PAIR', roundLimit: 5 });
    expect((await client.call('orchestrator.prefabs', {})).prefabs.filter((each) => !each.builtIn).map((each) => each.name)).toEqual(['PAIR']);

    await expect(client.call('orchestrator.savePrefab', { text: prefabFile(pair({ name: 'solo AGENT' })), replace: true })).rejects.toMatchObject({
      message: expect.stringContaining('built-in'),
    });
    await expect(client.call('orchestrator.removePrefab', { name: 'Lead and crew' })).rejects.toMatchObject({ message: expect.stringContaining("can't be removed") });
  });

  it('refuses a file it can’t read, saying why', async () => {
    const { client } = await prefabDaemon();
    await expect(client.call('orchestrator.savePrefab', { text: '{"agentBoardCrewPrefab": 1, "name": "x", "members": [], "prompt": "go"}' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'a crew prefab holds no prompt',
    });
  });

  it('lists a saved prefab this release can’t read by name and why, and still lists and removes the rest', async () => {
    const setup = await prefabDaemon();
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });
    // As an earlier release might have saved it, reading looser than this one.
    const db = new DatabaseSync(join(setup.dataDir, 'agent-board.db'));
    db.prepare("INSERT INTO crew_prefabs (name, body) VALUES ('Old', ?)").run(prefabFile(pair({ name: 'Old' })).replace('"roundLimit": 2', '"roundLimit": 99'));
    db.close();

    const library = await setup.client.call('orchestrator.prefabs', {});
    expect(library.prefabs.map((each) => each.name)).toContain('Pair');
    expect(library.unreadable).toEqual([{ name: 'Old', reason: 'the round limit is a whole number from 1 to 10' }]);
    await expect(setup.client.call('orchestrator.startPrefab', { name: 'old', zoneId: setup.zone.id })).rejects.toMatchObject({
      message: expect.stringContaining("the crew prefab Old can't be read"),
    });
    expect(await setup.client.call('orchestrator.removePrefab', { name: 'Old' })).toBeNull();
  });

  it('removes a saved prefab, and says when there is none', async () => {
    const { client } = await prefabDaemon();
    await client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });
    expect(await client.call('orchestrator.removePrefab', { name: 'pair' })).toBeNull();
    await expect(client.call('orchestrator.removePrefab', { name: 'pair' })).rejects.toMatchObject({ message: 'the library has no crew prefab named pair' });
  });

  it('is changed only by the user or an orchestrator of the whole board, and each change is logged', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup, 'zone');
    expect((await zoneLead.connection.call('orchestrator.prefabs', { token: zoneLead.token })).prefabs).toHaveLength(5);
    await expect(zoneLead.connection.call('orchestrator.savePrefab', { token: zoneLead.token, text: prefabFile(pair()) })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringContaining('reaches every board'),
    });
    const [refused] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(refused).toMatchObject({ action: 'save-prefab', targetName: 'Pair', outcome: 'refused' });

    const boardLead = await lead(setup, 'board');
    await boardLead.connection.call('orchestrator.savePrefab', { token: boardLead.token, text: prefabFile(pair()) });
    await boardLead.connection.call('orchestrator.removePrefab', { token: boardLead.token, name: 'Pair' });
    const [removed, saved] = await setup.client.call('orchestrator.activity', { orchestratorId: boardLead.agent.sessionId, limit: 2 });
    expect([saved, removed]).toMatchObject([
      { action: 'save-prefab', targetName: 'Pair', outcome: 'done' },
      { action: 'remove-prefab', targetName: 'Pair', outcome: 'done' },
    ]);
  });
});

describe('starting a crew from a prefab', () => {
  it('starts its builder with the prompt, as the prefab says, and lists the reviewers that start at its hand-off', async () => {
    const setup = await prefabDaemon();
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });

    const crew = await setup.client.call('orchestrator.startPrefab', { name: 'pair', prompt: 'Add a footer', zoneId: setup.zone.id });

    expect(crew.prefab).toBe('Pair');
    expect(crew.started).toHaveLength(1);
    expect(crew.started[0]).toMatchObject({ member: 'impl', role: 'implementer', harness: 'claude', model: 'opus', zoneId: setup.zone.id, spawnedBy: null });
    expect(crew.later).toEqual([{ member: 'review', starts: 'handoff', command: "agent-board new --base <impl's ref> --role reviewer --harness codex -- '<its task>'" }]);
    expect(await firstPrompt(setup, crew.started[0]!.sessionId)).toMatch(/Add a footer$/);
  });

  it('runs a crew for a prefab with reviewers at the hand-off: its builder handing over starts its reviewer on its branch', async () => {
    const setup = await prefabDaemon();
    expect((await setup.client.call('orchestrator.startPrefab', { name: 'Solo agent', prompt: 'Go', zoneId: setup.zone.id })).crew).toBeNull();

    // The fake implementer writes its handover and ends its turn.
    const started = await setup.client.call('orchestrator.startPrefab', { name: 'Implementer + reviewer', prompt: 'Add a footer', zoneId: setup.zone.id });
    const impl = started.started[0]!;
    expect(started.crew).toMatch(/^[0-9a-f]{8}$/);
    expect(await setup.client.call('orchestrator.crews', { crewId: `crew:${started.crew}` })).toEqual([
      expect.objectContaining({ id: started.crew, prefab: 'Implementer + reviewer', builder: impl.sessionId, round: 1, roundLimit: 3, reviewers: [] }),
    ]);

    await setup.recorder.waitFor(
      (e: DaemonEvent): e is DaemonEvent => e.type === 'agent.updated' && e.agent.reviews?.branch === impl.branch && e.agent.role === 'reviewer',
    );
    const [crew] = await setup.client.call('orchestrator.crews', {});
    expect(crew).toMatchObject({ phase: 'reviewing', reviewers: [{ member: 'review', round: 1, verdict: null }] });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);

    await setup.client.call('orchestrator.stopCrew', { crewId: started.crew! });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'stop-crew', targetName: 'Implementer + reviewer', outcome: 'done' });
    expect((await setup.client.call('orchestrator.crews', {}))[0]).toMatchObject({ phase: 'stopped', stopped: 'stopped' });
  });

  it('hands its reviewer’s review back to its builder as the reviewer’s hand-off, and the daemon stops mid-round cleanly', async () => {
    const setup = await prefabDaemon();
    const started = await setup.client.call('orchestrator.startPrefab', { name: 'Implementer + reviewer', prompt: 'Add a footer', zoneId: setup.zone.id });
    const impl = started.started[0]!;
    const reviewing = await setup.recorder.waitFor(
      (e: DaemonEvent): e is DaemonEvent & { type: 'agent.updated' } =>
        e.type === 'agent.updated' && e.agent.reviews?.branch === impl.branch && e.agent.role === 'reviewer' && e.agent.state === 'idle',
    );
    const reviewer = reviewing.agent;
    expect(reviewer.name).toBe('review (round 1)');

    // The fake reviewer leaves no review of its own: this one asks for changes, and its next update is heard.
    writeFileSync(join(reviewer.worktree, '.agent-board', 'review.md'), '# Not yet\nVerdict: Changes requested\n\n## Blocker\n- **No footer** `a.ts:1`: add it\n');
    await setup.client.call('orchestrator.setStatus', { sessionId: reviewer.sessionId, summary: 'Reviewed' });

    const handedBack = await setup.recorder.waitFor(
      (e: DaemonEvent): e is DaemonEvent & { type: 'agent.updated' } =>
        e.type === 'agent.updated' && e.agent.sessionId === impl.sessionId && (e.agent.lastMessage ?? '').includes('hand-off from review (round 1)'),
    );
    expect(handedBack.agent.lastMessage).toContain('(its review, round 1): # Not yet Verdict: Changes requested');
    await setup.recorder.waitFor((e: DaemonEvent): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === reviewer.sessionId);
    expect((await setup.client.call('orchestrator.crews', {}))[0]).toMatchObject({ round: 2, phase: 'building', reviewers: [{ verdict: 'changes-requested', blockers: 1 }] });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
    // The test's daemon stops here, with the crew mid-round: its agents stopping as it goes are no news to the crew.
  });

  it('tells each reviewer of a round the crew’s round, not the branch’s count of reviews', async () => {
    const setup = await prefabDaemon();
    const started = await setup.client.call('orchestrator.startPrefab', { name: 'Implementer + code + design reviewers', prompt: 'Add a footer', zoneId: setup.zone.id });
    const impl = started.started[0]!;
    const reviewers: string[] = [];
    await setup.recorder.waitFor((e: DaemonEvent): e is DaemonEvent => {
      if (e.type === 'agent.updated' && e.agent.reviews?.branch === impl.branch && !reviewers.includes(e.agent.sessionId)) reviewers.push(e.agent.sessionId);
      return reviewers.length === 2;
    });

    for (const sessionId of reviewers) expect(await firstPrompt(setup, sessionId)).toContain('review round 1.');
  });

  it('takes a round limit for this crew alone, keeping the prefab’s, and refuses one out of range', async () => {
    const setup = await prefabDaemon();
    const started = await setup.client.call('orchestrator.startPrefab', { name: 'Implementer + reviewer', prompt: 'Add a footer', zoneId: setup.zone.id, roundLimit: 5 });
    expect(await setup.client.call('orchestrator.crews', { crewId: started.crew! })).toEqual([expect.objectContaining({ roundLimit: 5 })]);
    const { prefabs } = await setup.client.call('orchestrator.prefabs', {});
    expect(prefabs.find((prefab) => prefab.name === 'Implementer + reviewer')!.roundLimit).toBe(3);
    await expect(setup.client.call('orchestrator.startPrefab', { name: 'Solo agent', prompt: 'Go', zoneId: setup.zone.id, roundLimit: 11 })).rejects.toThrow(/whole number from 1 to 10/);
  });

  it('starts its builder at the reasoning effort the prefab gives it', async () => {
    const setup = await prefabDaemon();
    await setup.client.call('orchestrator.savePrefab', {
      text: prefabFile(pair({ members: [{ ...pair().members[0]!, effort: 'xhigh' }, { ...pair().members[1]!, effort: 'high' }] })),
    });

    const { started, later } = await setup.client.call('orchestrator.startPrefab', { name: 'Pair', prompt: 'Go', zoneId: setup.zone.id });

    expect(started[0]).toMatchObject({ member: 'impl', effort: 'xhigh' });
    expect(later[0]!.command).toBe("agent-board new --base <impl's ref> --role reviewer --harness codex --effort high -- '<its task>'");
  });

  it('gives a lead each member’s reasoning effort in the command that starts it', async () => {
    const setup = await prefabDaemon();
    const led = pair({
      name: 'Led',
      members: [
        { ...pair().members[0]!, id: 'lead', role: 'orchestrator', effort: 'high' },
        { ...pair().members[0]!, model: 'sonnet', effort: 'low', starts: 'lead' },
      ],
    });
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(led) });

    const { started, later } = await setup.client.call('orchestrator.startPrefab', { name: 'Led', prompt: 'Go', zoneId: setup.zone.id });

    const command = "agent-board new --role implementer --harness claude --model sonnet --effort low -- '<its task>'";
    expect(started[0]).toMatchObject({ member: 'lead', effort: 'high' });
    expect(later).toEqual([{ member: 'impl', starts: 'lead', command }]);
    expect(await firstPrompt(setup, started[0]!.sessionId)).toContain(`- impl: \`${command}\``);
  });

  it('starts a named role with the prefab’s own template, filled in', async () => {
    const setup = await prefabDaemon();
    const designer = pair({
      name: 'Designer',
      members: [{ ...pair().members[0]!, role: 'designer', template: 'Design on {{branch}}.' }],
    });
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(designer) });

    const { started } = await setup.client.call('orchestrator.startPrefab', { name: 'Designer', prompt: 'The footer', zoneId: setup.zone.id });

    expect(await firstPrompt(setup, started[0]!.sessionId)).toBe(`Design on ${started[0]!.branch}.\n\nThe footer`);
    expect(started[0]!.template).toBe("the crew prefab's designer template");
  });

  it('gives a lead its prompt, then the crew it may start and the round limit', async () => {
    const setup = await prefabDaemon();

    const { started, later } = await setup.client.call('orchestrator.startPrefab', { name: 'Lead and crew', prompt: 'Ship the footer', zoneId: setup.zone.id });

    expect(started[0]).toMatchObject({ member: 'lead', roleName: 'orchestrator' });
    expect(later).toEqual([
      { member: 'impl', starts: 'lead', command: "agent-board new --role implementer --harness claude -- '<its task>'" },
      { member: 'review', starts: 'lead', command: "agent-board new --base <impl's ref> --role reviewer --harness claude -- '<its task>'" },
    ]);
    const prompt = await firstPrompt(setup, started[0]!.sessionId);
    expect(prompt).toContain('Ship the footer\n\nYou lead a crew from the Lead and crew prefab.');
    expect(prompt).toContain("- impl: `agent-board new --role implementer --harness claude -- '<its task>'`");
    expect(prompt).toContain("- review: `agent-board new --base <impl's ref> --role reviewer --harness claude -- '<its task>'`");
    expect(prompt).toContain('Run at most 3 review rounds, then stop and ask the user.');
  });

  it('quotes a shared file’s names and roles in its lead’s commands, so none can run a command of its own', async () => {
    const setup = await prefabDaemon();
    const hostile = pair({
      name: 'Shared crew',
      members: [
        { ...pair().members[0]!, id: 'lead', role: 'orchestrator', model: null, starts: 'prompt' },
        { ...pair().members[0]!, id: 'impl', role: "it's $(id)", name: "x'$(touch /tmp/pwned)'", model: 'claude-opus-5-5[1m]', starts: 'lead' },
      ],
    });
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(hostile) });

    const { started } = await setup.client.call('orchestrator.startPrefab', { name: 'Shared crew', prompt: 'Go', zoneId: setup.zone.id });

    expect(await firstPrompt(setup, started[0]!.sessionId)).toContain(
      "- impl: `agent-board new --role 'it'\\''s $(id)' --harness claude --model 'claude-opus-5-5[1m]' --name 'x'\\''$(touch /tmp/pwned)'\\''' -- '<its task>'`",
    );
  });

  it('refuses a lead in a zone that doesn’t let its agents orchestrate, which could start none of its crew', async () => {
    const setup = await prefabDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false });

    await expect(setup.client.call('orchestrator.startPrefab', { name: 'Lead and crew', prompt: 'Go', zoneId: setup.zone.id })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining("web doesn't let its agents orchestrate, so Lead and crew's lead could start none of its crew"),
    });
    expect((await setup.client.call('orchestrator.startPrefab', { name: 'Solo agent', prompt: 'Go', zoneId: setup.zone.id })).started).toHaveLength(1);
  });

  it('is started by an orchestrator as its own crew, and a lead needs two free levels below it', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup, 'zone');

    const { started } = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Implementer + reviewer', prompt: 'Fix it' });
    expect(started[0]).toMatchObject({ spawnedBy: zoneLead.agent.sessionId, zoneId: setup.zone.id });
    const [line] = await setup.client.call('orchestrator.activity', { orchestratorId: zoneLead.agent.sessionId, limit: 1 });
    expect(line).toMatchObject({ action: 'spawn', outcome: 'done' });

    // An agent one level down has one level left: enough for a builder, not for a lead and its crew.
    const solo = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Solo agent', prompt: 'Print your board identity' });
    const member = solo.started[0]!;
    await setup.client.call('agent.setOrchestrate', { sessionId: member.sessionId, scope: 'zone' });
    await setup.client.call('session.attach', { sessionId: member.sessionId });
    await setup.recorder.waitForText(member.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(member.sessionId))![1]!;
    const connection = await connectTestClient(setup.daemon);
    await connection.call('board.identify', { token });
    await expect(connection.call('orchestrator.startPrefab', { token, name: 'Lead and crew', prompt: 'Go' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringContaining('Lead and crew needs 2 free levels of crew depth below you'),
    });
    expect((await connection.call('orchestrator.startPrefab', { token, name: 'Solo agent', prompt: 'Go' })).started[0]).toMatchObject({ spawnedBy: member.sessionId });
  });

  it('is started by an orchestrator’s new_agent tool with prefab, which leaves the members to the prefab', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup, 'zone');
    const mcp = new McpClient(
      {
        command: TEST_CLI_LAUNCHER.command,
        args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
        env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: zoneLead.token },
      },
      tempDataDir(),
    );

    expect(await mcp.callTool('prefabs', {})).toMatchObject({ isError: false, text: expect.stringMatching(/^Solo agent +built-in/) });
    expect(await mcp.callTool('prefabs', { name: 'lead and crew' })).toMatchObject({ text: expect.stringContaining('"agentBoardCrewPrefab": 1') });
    expect(await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Implementer + reviewer' })).toMatchObject({
      isError: false,
      text: expect.stringContaining("review: starts on impl's branch each time impl hands off, a fresh one each round"),
    });
    expect(await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Implementer + reviewer', model: 'opus' })).toMatchObject({
      isError: true,
      text: expect.stringContaining("model is the prefab's to set"),
    });
  });

  it('draws no edges, even once its reviewer is started on the builder’s branch as the command says', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup, 'zone');
    const crew = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Implementer + reviewer', prompt: 'Fix it' });
    const impl = crew.started[0]!;
    expect(crew.later[0]!.command).toBe("agent-board new --base <impl's ref> --role reviewer --harness claude -- '<its task>'");

    const reviewer = await zoneLead.connection.call('orchestrator.spawn', { token: zoneLead.token, role: 'reviewer', baseBranch: impl.branch, prompt: 'Review it' });

    expect(reviewer.reviews?.branch).toBe(impl.branch);
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });

  it('logs a start it refuses before any agent is asked for', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup, 'zone');
    await expect(zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Nope' })).rejects.toThrow();
    const [line] = await setup.client.call('orchestrator.activity', { orchestratorId: zoneLead.agent.sessionId, limit: 1 });
    expect(line).toMatchObject({ action: 'spawn', outcome: 'refused', detail: 'crew prefab Nope' });
  });

  it('refuses a prefab the library hasn’t got', async () => {
    const { client, zone } = await prefabDaemon();
    await expect(client.call('orchestrator.startPrefab', { name: 'Nope', zoneId: zone.id })).rejects.toMatchObject({
      message: 'the library has no crew prefab named Nope: agent-board prefab ls lists them',
    });
  });
});
