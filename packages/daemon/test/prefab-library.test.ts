// The app's crew prefab library: one for every board, changed only by the user or a board-scope orchestrator, and a
// crew started from a prefab as an orchestrator's agent is.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { createFakeTracker, createMemoryCredentialStore } from '@agent-board/tracker/testing';
import { BUILT_IN_PREFABS, prefabFile } from '../src/crew-prefabs.ts';
import { graphFromStarts } from '../src/prefab-graph.ts';
import { MAX_PURPOSE_LENGTH, RPC_ERROR, type CrewPrefab, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function prefabDaemon(dataDir = tempDataDir(), trackers: Pick<NonNullable<Parameters<typeof startTestDaemon>[0]>, 'credentials' | 'trackers'> = {}) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
    ...trackers,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, dataDir, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof prefabDaemon>>;

/** An agent the user starts in the zone, with no role, connected as it with its board token. */
async function lead(setup: Setup) {
  const { daemon, client, recorder } = setup;
  const agent = await client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...SIZE });
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

/** An agent as the daemon lists it now. */
async function agentOf(setup: Setup, sessionId: string) {
  return (await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId)!;
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
      ['Ticket', true],
      ['Design, build, review', true],
      ['Just the chat', true],
    ]);

    const saved = await setup.client.call('orchestrator.savePrefab', { text: prefabFile(pair()) });
    expect(saved).toEqual({ ...pair(), ...graphFromStarts(pair()), builtIn: false, editedAt: expect.any(String) });

    await setup.daemon.stop();
    const again = await prefabDaemon(setup.dataDir);
    expect((await again.client.call('orchestrator.prefabs', {})).prefabs.at(-1)).toEqual(saved);
  });

  it('keeps where each agent sits on its board, beside its file, and drops what names no agent of it', async () => {
    const setup = await prefabDaemon();
    const places = { '@prompt': { x: -200, y: 40 }, impl: { x: 0, y: 0 }, review: { x: 320, y: 12.5 } };
    const saved = await setup.client.call('orchestrator.savePrefab', { text: prefabFile(pair()), places: { ...places, gone: { x: 1, y: 1 } } });
    expect(saved.places).toEqual(places);
    // The file itself stays as an older app reads it: the places are the library's, never the file's.
    expect(prefabFile(saved)).toBe(prefabFile(pair()));

    await setup.daemon.stop();
    const again = await prefabDaemon(setup.dataDir);
    expect((await again.client.call('orchestrator.prefabs', {})).prefabs.at(-1)?.places).toEqual(places);
    // Saved again with none (from the command line), it has none: its agents may have changed.
    const plain = await again.client.call('orchestrator.savePrefab', { text: prefabFile(pair()), replace: true });
    expect(plain).not.toHaveProperty('places');
    await expect(again.client.call('orchestrator.savePrefab', { text: prefabFile(pair()), replace: true, places: { impl: { x: 'left', y: 0 } } as never })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('place'),
    });
  });

  it('keeps where each input and loop gate of its graph sits, beside its agents', async () => {
    const { client } = await prefabDaemon();
    const places = { impl: { x: 0, y: 0 }, prompt: { x: -200, y: 40 }, loop: { x: 480, y: 30 }, end: { x: 600, y: 40 } };
    const saved = await client.call('orchestrator.savePrefab', { text: prefabFile(pair()), places });
    expect(saved.places).toEqual(places);
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
    db.prepare("INSERT INTO crew_prefabs (name, body) VALUES ('Old', ?)").run(prefabFile(pair({ name: 'Old' })).replace('"cap": 2', '"cap": 0'));
    db.close();

    const library = await setup.client.call('orchestrator.prefabs', {});
    expect(library.prefabs.map((each) => each.name)).toContain('Pair');
    expect(library.unreadable).toEqual([{ name: 'Old', reason: "loop gate loop's cap is a whole number from 1, or null for none" }]);
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

  it('is changed by the user or any agent, with no role, and each change is logged', async () => {
    const setup = await prefabDaemon();
    const boardLead = await lead(setup);
    expect((await boardLead.connection.call('orchestrator.prefabs', { token: boardLead.token })).prefabs).toHaveLength(BUILT_IN_PREFABS.length);
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

  it('starts a drafted prefab with a ticket input on a ticket no linked tracker can read: the agent gets the ticket as typed, to look up itself', async () => {
    const setup = await prefabDaemon();
    const drafted = pair({
      name: 'Drafted',
      members: [pair().members[0]!],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'ticket', kind: 'ticket' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'ticket', to: 'impl' },
        { from: 'impl', to: 'end' },
      ],
    });
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(drafted) });

    const crew = await setup.client.call('orchestrator.startPrefab', { name: 'Drafted', issueId: 'ABC-12', zoneId: setup.zone.id });

    const prompt = await firstPrompt(setup, crew.started[0]!.sessionId);
    expect(prompt).toContain('ABC-12');
    expect(prompt).toMatch(/look it up/i);
    // Named and branched after its ticket, linked to none.
    const agent = await agentOf(setup, crew.started[0]!.sessionId);
    expect(agent).toMatchObject({ name: 'ABC-12', issue: null });
    expect(agent.branch).toMatch(/^abc-12-[0-9a-f]+$/);

    // With a prompt too, named after both.
    const asked = await setup.client.call('orchestrator.startPrefab', { name: 'Drafted', issueId: 'ABC-13', prompt: 'Add a footer', zoneId: setup.zone.id });
    await firstPrompt(setup, asked.started[0]!.sessionId);
    const both = await agentOf(setup, asked.started[0]!.sessionId);
    expect(both.name).toBe('ABC-13: Add a footer');
    expect(both.branch).toMatch(/^abc-13-add-a-footer-[0-9a-f]+$/);
  });

  it("passes a ticket's link on as typed too, when no linked tracker can read it", async () => {
    const setup = await prefabDaemon();
    const drafted = pair({
      name: 'Drafted',
      members: [pair().members[0]!],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'ticket', kind: 'ticket' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'ticket', to: 'impl' },
        { from: 'impl', to: 'end' },
      ],
    });
    await setup.client.call('orchestrator.savePrefab', { text: prefabFile(drafted) });

    const crew = await setup.client.call('orchestrator.startPrefab', { name: 'Drafted', issueId: 'https://linear.app/acme/issue/ABC-12/add-a-footer', zoneId: setup.zone.id });

    const prompt = await firstPrompt(setup, crew.started[0]!.sessionId);
    expect(prompt).toContain('https://linear.app/acme/issue/ABC-12/add-a-footer');
    expect(prompt).toMatch(/look it up/i);
    // A link names it by its issue's key.
    expect((await agentOf(setup, crew.started[0]!.sessionId)).name).toBe('ABC-12');
  });

  it('starts a ticket on a ticket no linked tracker can read: its chat gets the ticket as typed', async () => {
    const setup = await prefabDaemon();

    const ticket = await setup.client.call('orchestrator.startPrefab', { name: 'Just the chat', issueId: 'https://github.com/acme/app-2/issues/34', zoneId: setup.zone.id });

    const prompt = await firstPrompt(setup, ticket.started[0]!.sessionId);
    expect(prompt).toContain('https://github.com/acme/app-2/issues/34');
    expect(prompt).toMatch(/look it up/i);
    const chat = await agentOf(setup, ticket.started[0]!.sessionId);
    expect(chat.name).toBe('#34');
    expect(chat.branch).toMatch(/^34-[0-9a-f]+$/);
  });

  it('starts a ticket in a zone bound to a tracker that is no longer connected: its chat gets the ticket as typed', async () => {
    const setup = await prefabDaemon(tempDataDir(), { credentials: createMemoryCredentialStore(), trackers: { linear: () => createFakeTracker() } });
    await setup.client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_good' });
    await setup.client.call('zone.setTracker', { id: setup.zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    await setup.client.call('tracker.disconnect', { provider: 'linear' });

    const ticket = await setup.client.call('orchestrator.startPrefab', { name: 'Just the chat', issueId: 'ACME-12', zoneId: setup.zone.id });

    expect(await firstPrompt(setup, ticket.started[0]!.sessionId)).toMatch(/ACME-12[\s\S]*look it up/i);
    expect(await agentOf(setup, ticket.started[0]!.sessionId)).toMatchObject({ name: 'ACME-12', issue: null });
  });

  it("starts a ticket as typed when the tracker's key can't be read from its store", async () => {
    const store = createMemoryCredentialStore();
    let unreadable = false;
    const credentials = {
      get: (account: string) => (unreadable ? Promise.reject(new Error('no keychain at /nowhere')) : store.get(account)),
      set: (account: string, secret: string) => store.set(account, secret),
      delete: (account: string) => store.delete(account),
    };
    const setup = await prefabDaemon(tempDataDir(), { credentials, trackers: { linear: () => createFakeTracker() } });
    await setup.client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_good' });
    await setup.client.call('zone.setTracker', { id: setup.zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    unreadable = true;

    const ticket = await setup.client.call('orchestrator.startPrefab', { name: 'Just the chat', issueId: 'ACME-12', zoneId: setup.zone.id });

    expect(await firstPrompt(setup, ticket.started[0]!.sessionId)).toMatch(/ACME-12[\s\S]*look it up/i);
    expect(await agentOf(setup, ticket.started[0]!.sessionId)).toMatchObject({ name: 'ACME-12', issue: null });
    // A plain start on that ticket, not asked to take it as typed, still fails on the store.
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, issueId: 'ACME-12', prompt: 'Go', cols: 80, rows: 24 })).rejects.toThrow(/no keychain/);
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

  it('starts a lead in any zone, which may start its crew there', async () => {
    const setup = await prefabDaemon();

    expect((await setup.client.call('orchestrator.startPrefab', { name: 'Lead and crew', prompt: 'Go', zoneId: setup.zone.id })).started).toHaveLength(1);
    expect((await setup.client.call('orchestrator.startPrefab', { name: 'Solo agent', prompt: 'Go', zoneId: setup.zone.id })).started).toHaveLength(1);
  });

  it('is started by an orchestrator as its own crew, a lead and its crew at any depth', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);

    const { started } = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Implementer + reviewer', prompt: 'Fix it' });
    expect(started[0]).toMatchObject({ spawnedBy: zoneLead.agent.sessionId, zoneId: setup.zone.id });
    const [line] = await setup.client.call('orchestrator.activity', { orchestratorId: zoneLead.agent.sessionId, limit: 1 });
    expect(line).toMatchObject({ action: 'spawn', outcome: 'done' });

    // An agent one level down starts a lead and its crew as its own, a crew going any depth.
    const solo = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Solo agent', prompt: 'Print your board identity' });
    const member = solo.started[0]!;
    await setup.client.call('session.attach', { sessionId: member.sessionId });
    await setup.recorder.waitForText(member.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(member.sessionId))![1]!;
    const connection = await connectTestClient(setup.daemon);
    await connection.call('board.identify', { token });
    // Its lead, two below the zone's orchestrator, may start its crew as any agent may.
    expect((await connection.call('orchestrator.startPrefab', { token, name: 'Lead and crew', prompt: 'Go' })).started[0]).toMatchObject({
      spawnedBy: member.sessionId,
    });
    expect((await connection.call('orchestrator.startPrefab', { token, name: 'Solo agent', prompt: 'Go' })).started[0]).toMatchObject({ spawnedBy: member.sessionId });
  });

  it('is started by an orchestrator’s new_agent tool with prefab, which leaves the members to the prefab', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);
    const mcp = new McpClient(
      {
        command: TEST_CLI_LAUNCHER.command,
        args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
        env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: zoneLead.token },
      },
      tempDataDir(),
    );

    expect(await mcp.callTool('prefabs', {})).toMatchObject({ isError: false, text: expect.stringMatching(/^Solo agent +built-in/) });
    expect(await mcp.callTool('prefabs', { name: 'lead and crew' })).toMatchObject({ text: expect.stringContaining('"agentBoardCrewPrefab": 2') });
    expect(await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Implementer + reviewer' })).toMatchObject({
      isError: false,
      text: expect.stringContaining("review: starts on impl's branch each time impl hands off, a fresh one each round"),
    });
    expect(await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Implementer + reviewer', model: 'opus' })).toMatchObject({
      isError: true,
      text: expect.stringContaining("model is the prefab's to set"),
    });
    // The name and branch it is given go to the member that starts on the prompt.
    expect(await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Solo agent', name: 'named solo', branch: 'solo-branch' })).toMatchObject({ isError: false });
    expect((await setup.client.call('agent.list')).find((agent) => agent.name === 'named solo')).toMatchObject({ branch: 'solo-branch' });
  });

  it('starts the agent with the description new_agent is given, with and without prefab, and says what was stored', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);
    const mcp = new McpClient(
      {
        command: TEST_CLI_LAUNCHER.command,
        args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
        env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: zoneLead.token },
      },
      tempDataDir(),
    );
    const purposeOf = async (name: string) => (await setup.client.call('agent.list')).find((agent) => agent.name === name)?.purpose;

    const plain = await mcp.callTool('new_agent', { prompt: 'Go', name: 'described', description: `Builds the\n overview ${'x'.repeat(100)}` });
    expect(plain).toMatchObject({ isError: false, text: expect.stringContaining('Its description: "Builds the overview ') });
    expect((await purposeOf('described'))!.length).toBe(MAX_PURPOSE_LENGTH);

    const crew = await mcp.callTool('new_agent', { prompt: 'Go', prefab: 'Solo agent', description: 'Tidies up' });
    expect(crew).toMatchObject({ isError: false, text: expect.stringContaining('Its description: "Tidies up"') });
    const started = (await setup.client.call('agent.list')).filter((agent) => agent.purpose === 'Tidies up');
    expect(started).toHaveLength(1);
  });

  it('is waited on by the wait tool given its crew ref alone, until it stops, as `agent-board wait crew:<id>`', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);
    const mcp = new McpClient(
      {
        command: TEST_CLI_LAUNCHER.command,
        args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
        env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: zoneLead.token },
      },
      tempDataDir(),
    );
    const started = await mcp.callTool('new_agent', { prompt: 'Fix it', prefab: 'Implementer + reviewer' });
    const crew = /agent-board wait (crew:[0-9a-f]{8})/.exec(started.text)![1]!;

    expect(await mcp.callTool('wait', { agents: [crew], timeout_seconds: 0 })).toMatchObject({
      isError: false,
      text: expect.stringMatching(new RegExp(`^${crew} {2}Implementer \\+ reviewer {2}round 1 of 3`)),
    });
    const waited = mcp.callTool('wait', { agents: [crew], timeout_seconds: 10 });
    // Past its first poll of the crew, which is still running, it is still waiting.
    const pending = Symbol('pending');
    expect(await Promise.race([waited, new Promise((resolve) => setTimeout(resolve, 1500, pending))])).toBe(pending);
    await zoneLead.connection.call('orchestrator.stopCrew', { token: zoneLead.token, crewId: crew });
    expect(await waited).toMatchObject({
      isError: false,
      text: expect.stringMatching(new RegExp(`^${crew} {2}Implementer \\+ reviewer {2}stopped after round 1 of 3`)),
    });

    const alone = { isError: true, text: expect.stringContaining('wait with a crew takes the one crew alone') };
    expect(await mcp.callTool('wait', { agents: [crew, 'agent:nope'] })).toMatchObject(alone);
    expect(await mcp.callTool('wait', { agents: [crew], until: ['finished'] })).toMatchObject(alone);
    expect(await mcp.callTool('wait', { agents: [crew], crew: true })).toMatchObject(alone);
  });

  it('draws no edges, even once its reviewer is started on the builder’s branch as the command says', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);
    const crew = await zoneLead.connection.call('orchestrator.startPrefab', { token: zoneLead.token, name: 'Implementer + reviewer', prompt: 'Fix it' });
    const impl = crew.started[0]!;
    expect(crew.later[0]!.command).toBe("agent-board new --base <impl's ref> --role reviewer --harness claude -- '<its task>'");

    const reviewer = await zoneLead.connection.call('orchestrator.spawn', { token: zoneLead.token, role: 'reviewer', baseBranch: impl.branch, prompt: 'Review it' });

    expect(reviewer.reviews?.branch).toBe(impl.branch);
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });

  it('logs a start it refuses before any agent is asked for', async () => {
    const setup = await prefabDaemon();
    const zoneLead = await lead(setup);
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
