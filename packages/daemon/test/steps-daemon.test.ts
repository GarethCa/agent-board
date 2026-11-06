import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { BOARD_ERROR, needsYouKind, needsYouNow, type Agent, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type Step, type StepsData } from '../src/protocol.ts';
import { answerFrom } from '../src/steps-ops.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake harnesses' `ask-plan` scenario: `Steps: …` puts up a steps card of its lines. */
async function stepsDaemon() {
  const daemon = await startTestDaemon({ worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'ask-plan', home: tempDataDir() }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'storefront' });
  const idle = async (sessionId: string): Promise<Agent> => {
    const matching = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && e.agent.state === 'idle';
    await recorder.waitFor(matching);
    return recorder.events.filter(matching).at(-1)!.agent;
  };
  /** The agent's board token, as it printed it, and a connection that speaks as it. */
  const asAgent = async (sessionId: string) => {
    await recorder.waitForText(sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });
    return { token, connection };
  };
  /** Starts an agent that puts up the steps `lines`, and waits for its turn to end. */
  const start = async (lines: string[], zoneId = zone.id, name = 'Release') => {
    const agent = await client.call('agent.spawn', { zoneId, harness: 'claude', prompt: `Steps: ${lines.join(' ;; ')}`, name, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await idle(agent.sessionId);
    return agent;
  };
  const cards = async () => (await client.call('item.list')).filter((item) => item.kind === 'steps');
  const cardOf = async (sessionId: string): Promise<BoardItem> => {
    const card = (await cards()).find((item) => (item.data as unknown as StepsData).madeBy.kind === 'agent' && (item.data as unknown as { madeBy: { sessionId: string } }).madeBy.sessionId === sessionId);
    if (card === undefined) throw new Error(`no steps card of ${sessionId}`);
    return card;
  };
  return { daemon, client, recorder, zone, start, asAgent, cards, cardOf, idle };
}

const dataOf = (item: BoardItem) => item.data as unknown as StepsData;

describe('steps cards an agent puts up through the board MCP', () => {
  it('puts the card beside the agent, and types the answers at its prompt on Send: all at first, then only what changed', async () => {
    const { client, recorder, start, cardOf } = await stepsDaemon();
    const agent = await start(['# Release 1.4', '## Before', '? Which database? [Postgres | SQLite] (required)', '? Ship on Friday? [yes/no]', '- [ ] Pin node 22']);
    await recorder.waitForText(agent.sessionId, 'beside your tile');
    await recorder.waitForText(agent.sessionId, 'once they press Send, the answers are typed at your prompt');
    const card = await cardOf(agent.sessionId);
    expect(card.zoneId).toBe(agent.zoneId);
    const data = dataOf(card);
    expect(data).toMatchObject({ title: 'Release 1.4', answeredBy: { kind: 'user' }, sent: null, closedAt: null });
    expect(data.steps.map((step) => [step.kind, step.section, step.who])).toEqual([
      ['one', 'Before', null],
      ['yes-no', 'Before', null],
      ['todo', 'Before', { kind: 'agent', sessionId: agent.sessionId, name: 'Release' }],
    ]);
    const [db, friday] = data.steps;

    await client.call('steps.answer', { id: card.id, stepId: friday!.id, answer: { yes: false } });
    await expect(client.call('steps.send', { id: card.id })).rejects.toThrow(/step 1 is required/);
    await expect(client.call('steps.answer', { id: card.id, stepId: db!.id, answer: { one: 2 } })).rejects.toThrow(/pick one of its 2 choices/);
    await client.call('steps.answer', { id: card.id, stepId: db!.id, answer: { one: 1 } });
    const sent = await client.call('steps.send', { id: card.id });
    expect(Object.keys(dataOf(sent).sent!.answers).sort()).toEqual([db!.id, friday!.id].sort());
    await recorder.waitForText(agent.sessionId, '[agent-board] The user answered your steps “Release 1.4”');
    await recorder.waitForText(agent.sessionId, '2. Ship on Friday?');

    await expect(client.call('steps.send', { id: card.id })).rejects.toThrow(/nothing changed/);
    await client.call('steps.answer', { id: card.id, stepId: friday!.id, answer: { yes: true } });
    await client.call('steps.send', { id: card.id });
    await recorder.waitForText(agent.sessionId, 'The user updated an answer on your steps “Release 1.4”');
  });

  it("lets the agent tick its own to-dos, wait on the user's, and add steps; told once the user ticks", async () => {
    const { client, recorder, start, asAgent, cardOf } = await stepsDaemon();
    const agent = await start(['# Weekly setup', '- [ ] Pull main', '- [ ] Rotate the key @user']);
    const { token, connection } = await asAgent(agent.sessionId);
    const card = await cardOf(agent.sessionId);
    const update = (change: unknown) => connection.call('board.updateSteps', { token, id: card.id, change: change as never });

    expect(dataOf(await update({ action: 'done', step: 1 })).steps[0]!.done).toMatchObject({ by: { kind: 'agent', sessionId: agent.sessionId } });
    await expect(update({ action: 'done', step: 2 })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope, message: /the user's to tick/ });
    await update({ action: 'wait', step: 2 });
    expect(dataOf(await update({ action: 'add', steps: [{ kind: 'todo', text: 'Tag it', section: null, required: false, choices: [], who: null, link: null, done: false }] })).steps).toHaveLength(3);
    const mine = await connection.call('board.readSteps', { token, mine: true });
    expect(mine.map((item) => item.id)).toEqual([card.id]);

    // The user's own methods are not the agent's.
    const refused = { code: BOARD_ERROR.notAllowed };
    await expect(connection.call('steps.tick', { id: card.id, stepId: dataOf(card).steps[1]!.id, done: true })).rejects.toMatchObject(refused);
    await expect(connection.call('steps.send', { id: card.id })).rejects.toMatchObject(refused);

    await client.call('steps.tick', { id: card.id, stepId: dataOf(card).steps[1]!.id, done: true });
    await recorder.waitForText(agent.sessionId, '[agent-board] Step 2 of “Weekly setup”');
    await recorder.waitForText(agent.sessionId, 'is done, ticked by the user: Rotate the key');
    expect(dataOf((await cardOf(agent.sessionId))).waits).toEqual([]);

    await update({ action: 'close' });
    await expect(update({ action: 'done', step: 3 })).rejects.toThrow(/is closed/);
    await expect(client.call('steps.tick', { id: card.id, stepId: dataOf(card).steps[1]!.id, done: false })).rejects.toThrow(/is closed/);
  });

  it("keeps a card to its scope: an agent in another zone can't read or change it", async () => {
    const { client, start, asAgent, cardOf } = await stepsDaemon();
    const mine = await start(['# Mine', '- [ ] Pull main']);
    const other = await client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const stranger = await start(['# Theirs', '- [ ] Their own'], other.id, 'Billing');
    const { token, connection } = await asAgent(stranger.sessionId);
    const card = await cardOf(mine.sessionId);
    const listed = await connection.call('board.readSteps', { token });
    expect(listed.map((item) => item.id)).toEqual([(await cardOf(stranger.sessionId)).id]);
    await expect(connection.call('board.readSteps', { token, id: card.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(connection.call('board.updateSteps', { token, id: card.id, change: { action: 'wait', step: 1 } })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    // Nor does it list it among the board's items, while the user's side lists every card.
    expect((await connection.call('item.list')).some((item) => item.id === card.id)).toBe(false);
    expect((await client.call('item.list')).some((item) => item.id === card.id)).toBe(true);

    // An orchestrator whose scope reaches the zone reads it too.
    await client.call('agent.setOrchestrate', { sessionId: stranger.sessionId, scope: 'board' });
    expect((await connection.call('board.readSteps', { token, id: card.id })).map((item) => item.id)).toEqual([card.id]);
    await client.call('agent.setOrchestrate', { sessionId: stranger.sessionId, scope: null });
    await expect(connection.call('board.readSteps', { token, id: card.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });

    // Loose, it is every agent's to read.
    await client.call('item.update', { id: card.id, zoneId: null, x: 9000, y: 0 });
    expect((await connection.call('board.readSteps', { token, id: card.id })).map((item) => item.id)).toEqual([card.id]);
  });

  it("puts a crew member's questions to its orchestrator, which answers and sends them", async () => {
    const { client, recorder, start, asAgent, cardOf } = await stepsDaemon();
    const lead = await start(['# Crew', '- [ ] Run the crew'], undefined, 'lead');
    await client.call('agent.setOrchestrate', { sessionId: lead.sessionId, scope: 'zone' });
    const { token, connection } = await asAgent(lead.sessionId);
    const crew = await connection.call('orchestrator.spawn', { token, name: 'crew', prompt: 'Steps: # Cache plan ;; ? Which store? [Redis | SQLite]' });
    await client.call('session.attach', { sessionId: crew.sessionId });
    await recorder.waitForText(crew.sessionId, 'lead, which started you, answers its questions');
    const card = await cardOf(crew.sessionId);
    expect(dataOf(card).answeredBy).toMatchObject({ kind: 'agent', sessionId: lead.sessionId });
    await recorder.waitForText(lead.sessionId, `a question to answer (agent-board steps read item:${card.id})`);
    await expect(client.call('steps.answer', { id: card.id, stepId: dataOf(card).steps[0]!.id, answer: { one: 0 } })).rejects.toThrow(/lead answers “Cache plan”/);

    await connection.call('board.updateSteps', { token, id: card.id, change: { action: 'answer', step: 1, answer: { one: 1 } } });
    await connection.call('board.updateSteps', { token, id: card.id, change: { action: 'send' } });
    await recorder.waitForText(crew.sessionId, '[agent-board] lead answered your steps “Cache plan”');
    await recorder.waitForText(crew.sessionId, 'SQLite');
    // Its flag pointed the lead at the card: answered, it goes.
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === crew.sessionId)!.flag).toBeNull();

    // Once the lead goes, the card is the user's to answer.
    await client.call('agent.delete', { sessionId: lead.sessionId, force: true });
    await client.call('steps.answer', { id: card.id, stepId: dataOf(card).steps[0]!.id, answer: { one: 0 } });
    await client.call('steps.send', { id: card.id });
    await recorder.waitForText(crew.sessionId, '[agent-board] The user updated an answer on your steps “Cache plan”');
  });

  it('types nothing it was not asked for: not at an agent named on a to-do, nor for its own tick, an add or a close', async () => {
    const { client, recorder, start, asAgent, cardOf } = await stepsDaemon();
    const named = await start(['# Theirs', '- [ ] Their own'], undefined, 'named');
    const maker = await start(['# Mine', '- [ ] Pull main']);
    const { token, connection } = await asAgent(maker.sessionId);
    const item = await cardOf(maker.sessionId);
    const update = (change: unknown) => connection.call('board.updateSteps', { token, id: item.id, change: change as never });
    await update({ action: 'add', steps: [{ kind: 'todo', text: 'Review it', section: null, required: false, choices: [], who: { kind: 'agent', sessionId: named.sessionId }, link: null, done: false }] });
    await update({ action: 'wait', step: 1 });
    await update({ action: 'done', step: 1 });
    await update({ action: 'close' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    for (const each of [named, maker]) expect(recorder.screenText(each.sessionId)).not.toContain('[agent-board]');
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === named.sessionId)!.flag).toBeNull();
  });

  it('tells a waiter once the card is closed, as it asked to hear of that step', async () => {
    const { recorder, start, asAgent, cardOf } = await stepsDaemon();
    const maker = await start(['# Weekly', '- [ ] Rotate the key @user']);
    const waiter = await start(['# Other', '- [ ] Something'], undefined, 'waiter');
    const card = await cardOf(maker.sessionId);
    const asWaiter = await asAgent(waiter.sessionId);
    await asWaiter.connection.call('board.updateSteps', { token: asWaiter.token, id: card.id, change: { action: 'wait', step: 1 } });
    const asMaker = await asAgent(maker.sessionId);
    await asMaker.connection.call('board.updateSteps', { token: asMaker.token, id: card.id, change: { action: 'close' } });
    await recorder.waitForText(waiter.sessionId, "[agent-board] Release closed “Weekly”");
    await recorder.waitForText(waiter.sessionId, "step 1 (Rotate the key) won't be ticked there now");
  });

  it('refuses a change that would make the card too big to keep, and a refused Send tells no one', async () => {
    const { client, recorder, start, asAgent } = await stepsDaemon();
    const agent = await start(['# Placeholder', '- [ ] First']);
    const { token, connection } = await asAgent(agent.sessionId);
    const draft = (kind: 'todo' | 'words', at: number) => ({ kind, text: `${at} ${'t'.repeat(490)}`, section: null, required: false, choices: [], who: null, link: kind === 'todo' ? 'l'.repeat(500) : null, done: false });
    const big = await connection.call('board.newSteps', { token, title: 'Big', steps: [...Array.from({ length: 12 }, (_, at) => draft('words', at)), ...Array.from({ length: 38 }, (_, at) => draft('todo', at))] });
    const answer = (stepId: string, words: string | null) =>
      client.call('steps.answer', { id: big.id, stepId, answer: words === null ? null : { words } }).then(() => undefined, (error: Error) => error);
    const questions = dataOf(big).steps.filter((step) => step.kind === 'words');
    let full = 0;
    while ((await answer(questions[full]!.id, 'é'.repeat(2_000))) === undefined) full++;
    expect((await answer(questions[full]!.id, 'é'.repeat(2_000)))?.message).toMatch(/that answer would make “Big” too big to keep \(\d+ bytes, at most 65536\): shorten its longest answers or steps/);
    // The longest answer that still fits leaves no room to keep a Send.
    let [fits, over] = [0, 2_000];
    while (over - fits > 1) {
      const mid = Math.floor((fits + over) / 2);
      if ((await answer(questions[full]!.id, 'é'.repeat(mid))) === undefined) fits = mid;
      else over = mid;
    }
    expect((await client.call('steps.send', { id: big.id }).catch((error: Error) => error)) as Error).toMatchObject({ message: /sending would make “Big” too big to keep/ });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorder.screenText(agent.sessionId)).not.toContain('your steps “Big”');

    await answer(questions[0]!.id, null);
    await client.call('steps.send', { id: big.id });
    await recorder.waitForText(agent.sessionId, '[agent-board] The user answered your steps “Big”');
    expect(recorder.screenText(agent.sessionId).split('The user answered your steps “Big”')).toHaveLength(2);
  });

  it("keeps a list the user makes as a card of the user's, which only the user ticks and which has no one to send to", async () => {
    const { client, zone } = await stepsDaemon();
    const user = { kind: 'user' } as const;
    const step = { id: 's1', kind: 'todo', text: 'Water the plants', section: null, required: false, choices: [], who: user, link: null, done: null, answer: null };
    const data: StepsData = { title: 'Weekly', madeBy: user, answeredBy: user, steps: [step as Step], sent: null, waits: [], closedAt: null };
    const card = await client.call('item.create', { kind: 'steps', zoneId: zone.id, x: 0, y: 0, width: 300, height: 120, data: { ...data } });
    expect(dataOf(await client.call('steps.tick', { id: card.id, stepId: 's1', done: true })).steps[0]!.done).toMatchObject({ by: user });
    await expect(client.call('steps.send', { id: card.id })).rejects.toThrow(/the user made this list/);
    await expect(client.call('item.create', { kind: 'steps', zoneId: null, x: 0, y: 0, width: 300, height: 120, data: { ...data, steps: [{ ...step, choices: ['a'] }] } })).rejects.toThrow(
      /step 1: only a question has choices/,
    );
    // An answer must be one its step takes, and every step an id of its own.
    const pick = { ...step, id: 's2', kind: 'one', who: null, choices: ['a', 'b'], answer: { value: { one: 99 }, by: user, at: '' } };
    const create = (steps: unknown[]) => client.call('item.create', { kind: 'steps', zoneId: null, x: 0, y: 0, width: 300, height: 120, data: { ...data, steps } as never });
    await expect(create([pick])).rejects.toThrow(/step 1's answer: pick one of its 2 choices/);
    await expect(create([step, step])).rejects.toThrow(/an id of their own/);
    await expect(create([{ ...step, done: { by: 'me' } }])).rejects.toThrow(/step 1 must be/);
  });

  it('refuses steps it can’t take, saying which', async () => {
    const { recorder, client } = await stepsDaemon();
    const zone = (await client.call('zone.list'))[0]!;
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'claude', prompt: 'Steps: # Bad ;; ? Pick [only one]', name: 'Bad', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, 'line 2: a question with choices needs at least 2');
  });
});

describe('Needs you, for a steps card an agent waits on', () => {
  /** The agent as the daemon lists it now. */
  const listed = async (client: Awaited<ReturnType<typeof stepsDaemon>>['client'], sessionId: string) => (await client.call('agent.list')).find((each) => each.sessionId === sessionId)!;

  it('lists an agent whose set the user answers, by its first open question, until its answers are sent', async () => {
    const { client, start, cardOf } = await stepsDaemon();
    const agent = await start(['# Release 1.4', '? Which database? [Postgres | SQLite]', '? Ship on Friday? [yes/no]', '- [ ] Pin node 22']);
    const card = await cardOf(agent.sessionId);
    const [db, friday] = dataOf(card).steps;
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toEqual({
      kind: 'steps',
      itemId: card.id,
      title: 'Release 1.4',
      stepId: db!.id,
      text: 'Which database?',
      open: 2,
      since: card.createdAt,
    });
    const asked = await listed(client, agent.sessionId);
    expect(needsYouKind(asked, 'explicit')).toBe('steps');
    expect(needsYouNow(asked, 'explicit')).toBe(true);

    // An answer moves it on, and isn't a new request: what the user saw stays seen.
    await client.call('agent.markSeen', { sessionId: agent.sessionId });
    await client.call('steps.answer', { id: card.id, stepId: db!.id, answer: { one: 1 } });
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait?.stepId).toBe(friday!.id);
    expect((await listed(client, agent.sessionId)).seen).toBe(true);

    await client.call('steps.send', { id: card.id });
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toBeNull();
  });

  it("lists an agent waiting on the user's to-do until the user ticks it, and never a list the user made", async () => {
    const { client, start, asAgent, cardOf } = await stepsDaemon();
    const agent = await start(['# Weekly setup', '- [ ] Pull main', '- [ ] Rotate the key @user']);
    const { token, connection } = await asAgent(agent.sessionId);
    const card = await cardOf(agent.sessionId);
    expect((await listed(client, agent.sessionId)).stepsWait).toBeNull();

    await connection.call('board.updateSteps', { token, id: card.id, change: { action: 'wait', step: 2 } });
    const key = dataOf(card).steps[1]!;
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toMatchObject({ kind: 'todo', itemId: card.id, stepId: key.id, text: 'Rotate the key', open: 0 });
    expect(needsYouKind(await listed(client, agent.sessionId), 'explicit')).toBe('todo');

    await client.call('steps.tick', { id: card.id, stepId: key.id, done: true });
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toBeNull();

    // A list the user makes waits on no one.
    const own = await client.call('item.create', { kind: 'steps', zoneId: null, x: 0, y: 0, width: 280, height: 104, data: { title: 'Mine', madeBy: { kind: 'user' }, answeredBy: { kind: 'user' }, steps: [], sent: null, waits: [], closedAt: null } });
    expect(own.kind).toBe('steps');
    expect((await client.call('agent.list')).filter((each) => each.stepsWait !== null)).toEqual([]);
  });

  it('lists a set again once its agent is resumed: a stop takes it off, a resume puts it back', async () => {
    const { client, start, cardOf } = await stepsDaemon();
    const agent = await start(['# Release 1.4', '? Which database? [Postgres | SQLite]']);
    const card = await cardOf(agent.sessionId);
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait?.itemId).toBe(card.id);

    await client.call('agent.stop', { sessionId: agent.sessionId });
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toBeNull();
    await client.call('agent.resume', { sessionId: agent.sessionId });
    await expect.poll(async () => (await listed(client, agent.sessionId)).stepsWait).toMatchObject({ kind: 'steps', itemId: card.id });
    // Back, it is a request again: unread, as it was never answered.
    expect((await listed(client, agent.sessionId)).seen).toBe(false);
  });

  it("leaves a crew member's set to its orchestrator, and lists it for the user once the orchestrator goes", async () => {
    const { client, recorder, start, asAgent, cardOf } = await stepsDaemon();
    const lead = await start(['# Crew', '- [ ] Run the crew'], undefined, 'lead');
    await client.call('agent.setOrchestrate', { sessionId: lead.sessionId, scope: 'zone' });
    const { token, connection } = await asAgent(lead.sessionId);
    const crew = await connection.call('orchestrator.spawn', { token, name: 'crew', prompt: 'Steps: # Cache plan ;; ? Which store? [Redis | SQLite]' });
    await client.call('session.attach', { sessionId: crew.sessionId });
    await recorder.waitForText(crew.sessionId, 'lead, which started you, answers its questions');
    const card = await cardOf(crew.sessionId);
    expect((await listed(client, crew.sessionId)).stepsWait).toBeNull();

    // Stopped, the lead hands the set to the user; resumed, it answers it again.
    await client.call('agent.stop', { sessionId: lead.sessionId });
    await expect.poll(async () => (await listed(client, crew.sessionId)).stepsWait).toMatchObject({ kind: 'steps', itemId: card.id });
    await client.call('agent.resume', { sessionId: lead.sessionId });
    await expect.poll(async () => (await listed(client, crew.sessionId)).stepsWait).toBeNull();

    await client.call('agent.delete', { sessionId: lead.sessionId, force: true });
    await expect.poll(async () => (await listed(client, crew.sessionId)).stepsWait).toMatchObject({ kind: 'steps', itemId: card.id });
  });
});

describe('an ask put on the board', () => {
  /** Starts an agent that asks `questions` (`Ask several: …`), and waits for its ask. */
  const asking = async (daemon: Awaited<ReturnType<typeof stepsDaemon>>, questions: string) => {
    const { client, recorder, zone } = daemon;
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'claude', prompt: `Ask several: ${questions}`, name: 'Cache', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    const asks = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.ask !== null;
    await recorder.waitFor(asks);
    return { agent, ask: recorder.events.filter(asks).at(-1)!.agent.ask! };
  };

  it('becomes a steps card holding the answers so far, and its Send answers the agent’s waiting call, typing nothing', async () => {
    const daemon = await stepsDaemon();
    const { client, recorder, idle } = daemon;
    const { agent, ask } = await asking(daemon, 'Which store? | Redis | SQLite ;; Keep the old limit? | Yes | No ;; Anything else?');
    expect(ask.questions.map((each) => each.question)).toEqual(['Which store?', 'Keep the old limit?', 'Anything else?']);
    await client.call('ask.answer', { sessionId: agent.sessionId, askId: ask.id, answer: { option: 1 }, index: 0 });

    const card = await client.call('ask.toCard', { sessionId: agent.sessionId, askId: ask.id });
    const data = dataOf(card);
    expect(card.zoneId).toBe(agent.zoneId);
    expect(data).toMatchObject({ title: 'Cache asks 3 questions', madeBy: { kind: 'agent', sessionId: agent.sessionId }, answeredBy: { kind: 'user' }, fromAsk: { askId: ask.id, ended: null } });
    expect(data.steps.map((step) => [step.kind, step.text, step.choices, step.answer?.value ?? null])).toEqual([
      ['one', 'Which store?', ['Redis', 'SQLite'], { one: 1 }],
      ['one', 'Keep the old limit?', ['Yes', 'No'], null],
      ['words', 'Anything else?', [], null],
    ]);
    // Answered on its card from now on: the agent still waits.
    await expect(client.call('ask.answer', { sessionId: agent.sessionId, askId: ask.id, answer: { option: 0 }, index: 1 })).rejects.toThrow(/on its card/);
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.ask).toMatchObject({ id: ask.id, card: card.id });

    const [, limit, words] = data.steps;
    await client.call('steps.answer', { id: card.id, stepId: limit!.id, answer: { one: 0 } });
    await client.call('steps.answer', { id: card.id, stepId: words!.id, answer: { words: 'Ship it Friday' } });
    const sent = await client.call('steps.send', { id: card.id });
    expect(dataOf(sent).fromAsk).toEqual({ askId: ask.id, ended: { at: expect.any(String), how: 'sent' } });
    await recorder.waitForText(agent.sessionId, 'The user answered:');
    await recorder.waitForText(agent.sessionId, 'Ship it Friday');
    await idle(agent.sessionId);
    expect(recorder.screenText(agent.sessionId)).not.toContain('[agent-board] The user answered your steps');

    // Its call answered, a change after is typed at its prompt, as any card's is.
    await client.call('steps.answer', { id: card.id, stepId: limit!.id, answer: { one: 1 } });
    await client.call('steps.send', { id: card.id });
    await recorder.waitForText(agent.sessionId, 'The user updated an answer on your steps “Cache asks 3 questions”');
  });

  it('gives the ask back to the agent’s tile once its card is taken off the board', async () => {
    const daemon = await stepsDaemon();
    const { client } = daemon;
    const { agent, ask } = await asking(daemon, 'Which store? | Redis | SQLite ;; Anything else?');
    const card = await client.call('ask.toCard', { sessionId: agent.sessionId, askId: ask.id });
    await client.call('item.delete', { id: card.id });
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.ask).toMatchObject({ id: ask.id, card: null });
    await client.call('ask.answer', { sessionId: agent.sessionId, askId: ask.id, answer: { option: 0 }, index: 0 });
  });

  it('takes its card back when an undo puts it back on the board, so only the card answers it', async () => {
    const daemon = await stepsDaemon();
    const { client, recorder } = daemon;
    const { agent, ask } = await asking(daemon, 'Which store? | Redis | SQLite ;; Anything else?');
    const card = await client.call('ask.toCard', { sessionId: agent.sessionId, askId: ask.id });
    await client.call('item.delete', { id: card.id });
    // An undo makes it again with its id and data.
    const { id, kind, zoneId, x, y, width, height, data } = card;
    await client.call('item.create', { id, kind, zoneId, x, y, width, height, data });
    await expect.poll(async () => (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.ask?.card).toBe(card.id);
    await expect(client.call('ask.send', { sessionId: agent.sessionId, askId: ask.id })).rejects.toThrow(/on its card/);

    const [store] = dataOf(card).steps;
    await client.call('steps.answer', { id: card.id, stepId: store!.id, answer: { one: 0 } });
    await client.call('steps.send', { id: card.id });
    await recorder.waitForText(agent.sessionId, 'The user answered:');
  });

  it('says a card answers nothing once its ask stopped waiting, and types its answers at the prompt', async () => {
    const daemon = await stepsDaemon();
    const { client, recorder, idle } = daemon;
    const { agent, ask } = await asking(daemon, 'Which store? | Redis | SQLite ;; Anything else?');
    const card = await client.call('ask.toCard', { sessionId: agent.sessionId, askId: ask.id });
    await client.call('item.delete', { id: card.id });
    await client.call('ask.answer', { sessionId: agent.sessionId, askId: ask.id, answer: { skip: true } });
    await idle(agent.sessionId);
    // Put back after its ask ended, it is stamped, and its Send is typed.
    const { id, kind, zoneId, x, y, width, height, data } = card;
    await client.call('item.create', { id, kind, zoneId, x, y, width, height, data });
    await expect.poll(async () => dataOf((await client.call('item.list')).find((item) => item.id === card.id)!).fromAsk?.ended?.how).toBe('stopped');
    const [store] = dataOf(card).steps;
    await client.call('steps.answer', { id: card.id, stepId: store!.id, answer: { one: 1 } });
    await client.call('steps.send', { id: card.id });
    await recorder.waitForText(agent.sessionId, '[agent-board] The user answered your steps');
  });

  it('refuses an ask of more than four questions: that is a steps card', async () => {
    const daemon = await stepsDaemon();
    const { client, recorder, zone } = daemon;
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'claude', prompt: 'Ask several: One? ;; Two? ;; Three? ;; Four? ;; Five?', name: 'Many', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, "That's a steps card: use steps_new");
  });
});

describe('agent-board steps', () => {
  /** Runs `agent-board steps <args>` with `env`: what it printed and its exit code. */
  async function steps(env: NodeJS.ProcessEnv, ...args: string[]) {
    let out = '';
    let err = '';
    const code = await runBoardCommand('steps', args, { out: (text) => (out += text), err: (text) => (err += text), env });
    return { code, out, err };
  }

  it('puts up, lists, reads, ticks, adds to and closes a card as the agent', async () => {
    const { daemon, start, asAgent } = await stepsDaemon();
    const agent = await start(['# Placeholder', '- [ ] First']);
    const { token } = await asAgent(agent.sessionId);
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token };

    const made = await steps(env, 'new', '--title', 'Ship 1.4', '--', '## Before', '- [ ] Pull main', '? Which day? [Thu | Fri] (required)');
    expect(made).toMatchObject({ code: 0, err: '' });
    expect(made.out).toMatch(/^Put item:\w+ {2}“Ship 1\.4” {2}0\/2 done {2}by agent:\w+ Release {2}\(in zone:\w+ storefront\) beside your tile\./);
    expect(made.out).toContain('once they press Send, the answers are typed at your prompt');
    const ref = /^Put (item:\w+)/.exec(made.out)![1]!;

    expect((await steps(env, 'ls')).out.split('\n').filter(Boolean)).toHaveLength(2);
    const read = await steps(env, 'read', ref);
    expect(read.out).toContain('  ## Before\n  1. - [ ] Pull main @agent:');
    expect(read.out).toContain('  2. ? Which day? [Thu | Fri] (required)');
    expect((await steps(env, 'done', ref, '1')).out).toMatch(/^Ticked step 1\.\n.*\n.*\n {2}## Before\n {2}1\. - \[x\] Pull main/);
    expect((await steps(env, 'ls', '--mine')).out).toContain('Placeholder');
    expect((await steps(env, 'ls', '--mine')).out).not.toContain('Ship 1.4');
    expect((await steps(env, 'add', ref, '--', '- [ ] Tag it @user')).out).toContain('  3. - [ ] Tag it @user');
    expect((await steps(env, 'wait', ref, '3')).out).toContain('You are told at your prompt once step 3 is done');
    expect((await steps(env, 'done', ref, '3')).err).toContain("step 3 is the user's to tick, not yours");
    expect((await steps(env, 'answer', ref, '2', 'Fri')).err).toContain('the user answers “Ship 1.4”, not you');
    expect((await steps(env, 'close', ref)).out).toContain('Closed it');
  });

  it('says what is wrong before it connects', async () => {
    expect((await steps({}, 'new')).err).toContain('give the steps, one a line');
    expect((await steps({}, 'done', 'item:1')).err).toContain('give the number of each step to tick');
    expect((await steps({}, 'wait', 'item:1', 'two')).err).toContain("give the step's number, from 1, not two");
    expect((await steps({}, 'ls', '--title', 'x')).err).toContain('--title is only for `steps new`');
    expect((await steps({}, 'read', 'item:1', '--send')).err).toContain('--send is only for `steps answer`');
    expect((await steps({}, 'shuffle')).err).toContain('the steps commands are `steps new`');
  });
});

describe('an answer typed for a question', () => {
  const question = (kind: Step['kind'], choices: string[] = []): Step => ({ id: 'q', kind, text: 'Q', section: null, required: false, choices, who: null, link: null, done: null, answer: null });

  it('takes a choice by number or text, several by commas, yes or no, or words', () => {
    expect(answerFrom(question('one', ['Postgres', 'SQLite']), 'sqlite')).toEqual({ one: 1 });
    expect(answerFrom(question('one', ['Postgres', 'SQLite']), '1')).toEqual({ one: 0 });
    expect(answerFrom(question('any', ['lint', 'unit', 'e2e']), '3, lint')).toEqual({ any: [2, 0] });
    expect(answerFrom(question('any', ['lint', 'unit']), 'none')).toEqual({ any: [] });
    expect(answerFrom(question('yes-no'), 'Y')).toEqual({ yes: true });
    expect(answerFrom(question('order', ['a', 'b']), 'b,a')).toEqual({ order: [1, 0] });
    expect(answerFrom(question('words'), '  Mostly fine  ')).toEqual({ words: 'Mostly fine' });
  });

  it('says what it can’t take', () => {
    expect(() => answerFrom(question('one', ['a', 'b']), 'c')).toThrow('"c" is not one of its choices: 1. a, 2. b');
    expect(() => answerFrom(question('yes-no'), 'maybe')).toThrow('answer yes or no');
    expect(() => answerFrom(question('todo'), 'x')).toThrow('tick it with `steps done`');
  });
});
