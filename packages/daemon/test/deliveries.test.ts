import { describe, expect, it } from 'vitest';
import { drawRateLimitMenu, rateLimitMenuRows } from '@agent-board/fake-harness';
import { createDeliveries, type DeliveryRow, type PromptNow } from '../src/deliveries.ts';
import { invalidParams } from '../src/params.ts';
import type { AgentState } from '../src/protocol.ts';
import type { RunStart } from '../src/schedules.ts';
import { createFakeClock } from './fake-clock.ts';

interface Row extends DeliveryRow {
  session_id: string;
}

const row = (sessionId: string, fields: Partial<Row> = {}): Row => ({
  session_id: sessionId,
  name: sessionId,
  ended_at: null,
  harness_session_id: null,
  hibernated_at: null,
  ...fields,
});

/** Lets what was waiting on settled promises run: deliveries wait on nothing else. */
const flush = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

/**
 * Deliveries over the agents `rows`, on a fake clock, recording what is written, relaunched and announced. Each prompt
 * stands where `prompt` says.
 */
function setup(rows: Row[], notReady?: string) {
  const writes: [string, string][] = [];
  const relaunches: { sessionId: string; prompt: string | undefined; why: string; codexSessionId: string | null | undefined }[] = [];
  const announced: { sessionId: string; handingOff: boolean }[] = [];
  /** What was handed back, never typed: `sessionId what: text (reason)`. */
  const undelivered: string[] = [];
  /** What the user was told of messages given up on at a prompt, and of them going: `notSent`'s arguments. */
  const notSent: unknown[][] = [];
  const byId = new Map(rows.map((each) => [each.session_id, each]));
  const clock = createFakeClock(new Date('2026-10-22T10:00:00Z'));
  const prompt: { now: PromptNow } = { now: 'at-prompt' };
  /** The state the agents show, and what they last said. */
  const shown: { state: AgentState; lastMessage?: string } = { state: 'idle' };
  /** Why the agents can't take a run now, if they can't. */
  const ready: { why: string | undefined } = { why: notReady };
  /** What writing to an agent's terminal throws, if it fails. */
  const failing: { write: Error | undefined } = { write: undefined };
  const deliveries = createDeliveries<Row>({
    write(sessionId, data) {
      if (failing.write !== undefined) throw failing.write;
      writes.push([sessionId, data]);
    },
    getRow: (sessionId) => byId.get(sessionId),
    requireAgent(sessionId) {
      const found = byId.get(sessionId);
      if (found === undefined) throw invalidParams(`no agent ${sessionId}`);
      return { name: found.name, endedAt: found.ended_at, state: shown.state, lastMessage: shown.lastMessage ?? null };
    },
    whyNotReady: () => ready.why,
    pausing: () => undefined,
    relaunch(target, prompt, why, codexSessionId): RunStart {
      relaunches.push({ sessionId: target.session_id, prompt, why, codexSessionId });
      return { started: true };
    },
    promptNow: () => prompt.now,
    announce: (sessionId) => void announced.push({ sessionId, handingOff: deliveries.isHandingOff(sessionId) }),
    undelivered: (sessionId, what, text, reason) => void undelivered.push(`${sessionId} ${what}: ${text} (${reason})`),
    notSent: (...args) => void notSent.push(args),
    log: () => {},
    clock,
    submitConfirmMs: 1_000,
  });

  /** Moves the fake clock on by `ms` a millisecond at a time, letting what waits on each timer run before the next. */
  const advance = async (ms: number) => {
    await flush();
    for (let step = 0; step < ms; step += 1) {
      clock.advance(1);
      await flush();
    }
  };

  /** The harness draws what was typed at once, Enter lands once the terminal is quiet, and its turn starts. */
  const land = async (sessionId: string) => {
    await flush();
    deliveries.outputSeen(sessionId);
    await advance(150);
    deliveries.turnSeen(sessionId);
    await flush();
  };

  return { deliveries, writes, relaunches, announced, undelivered, notSent, prompt, shown, ready, failing, advance, land };
}

describe('deliveries', () => {
  it("types an agent's first prompt only once its session is up, then the messages and runs sent to it before then, in order", async () => {
    const { deliveries, writes, land, advance, prompt } = setup([row('a'), row('from', { name: 'planner' })]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests\nthen push', up);
    // However long its session takes: nothing is typed blind, and nothing else is typed first.
    await advance(5_000);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    // A hand-off is busy at once, for its edge to keep and try again: never holding its sender handing off meanwhile.
    expect(await deliveries.deliver('from', 'a', 'plan', 'the plan')).toEqual({
      started: false,
      reason: "its session isn't up yet: its first prompt goes first",
      busy: true,
    });
    expect(deliveries.isHandingOff('from')).toBe(false);
    expect(deliveries.runScheduled('a', 'Nightly')).toEqual({ started: true, queued: true });
    expect(deliveries.queuedUntilUp('a')).toBe(2);
    expect(deliveries.whyNotUp('a')).toBe("its session isn't up yet: its first prompt goes first");
    expect(writes).toEqual([]);

    comeUp(true);
    await land('a');
    expect(deliveries.whyNotUp('a')).toBeUndefined();
    expect(writes.slice(0, 2)).toEqual([
      ['a', '\x1b[200~Fix the tests\rthen push\x1b[201~'],
      ['a', '\r'],
    ]);
    // At work on its first prompt: each queued message gets one Enter, which queues it for after that turn.
    prompt.now = 'working';
    for (let each = 0; each < 3; each += 1) {
      deliveries.outputSeen('a');
      await advance(200);
    }
    expect(writes.slice(2).map(([, data]) => data)).toEqual(['Also lint', '\r', 'Nightly', '\r']);
    expect(deliveries.queuedUntilUp('a')).toBe(0);
  });

  it('holds what is sent to an agent launched with no first prompt until its session is up, then types it', async () => {
    const { deliveries, writes, land, advance } = setup([row('a'), row('from', { name: 'planner' })]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', undefined, up);
    await advance(5_000);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    expect(await deliveries.deliver('from', 'a', 'plan', 'the plan')).toEqual({
      started: false,
      reason: "its session isn't up yet",
      busy: true,
    });
    expect(deliveries.whyNotUp('a')).toBe("its session isn't up yet");
    expect(writes).toEqual([]);

    comeUp(true);
    await land('a');
    expect(deliveries.whyNotUp('a')).toBeUndefined();
    // Nothing of its own is typed: the message is first.
    expect(writes).toEqual([
      ['a', 'Also lint'],
      ['a', '\r'],
    ]);
    expect(deliveries.queuedUntilUp('a')).toBe(0);
  });

  it('hands back the messages and runs queued for an agent whose session ended before it was up', async () => {
    const a = row('a');
    const { deliveries, writes, land, undelivered } = setup([a]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests', up);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    expect(deliveries.runScheduled('a', 'Nightly')).toEqual({ started: true, queued: true });
    a.ended_at = '2026-10-22T10:00:01Z';
    comeUp(false);
    await land('a');
    expect(writes).toEqual([]);
    expect(undelivered).toEqual(['a A message: Also lint (a has ended)', 'a A scheduled run: Nightly (a has ended)']);
    expect(deliveries.queuedUntilUp('a')).toBe(0);
  });

  it('hands back what is still queued for an agent not up yet as the daemon closes, once only', async () => {
    const a = row('a');
    const { deliveries, writes, land, undelivered } = setup([a]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests', up);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    expect(deliveries.runScheduled('a', 'Nightly')).toEqual({ started: true, queued: true });
    deliveries.handBackQueued();
    expect(undelivered).toEqual([
      'a A message: Also lint (the daemon shut down before it was up)',
      'a A scheduled run: Nightly (the daemon shut down before it was up)',
    ]);
    // Its session then ends with the daemon: nothing is handed back twice.
    a.ended_at = '2026-10-22T10:00:01Z';
    comeUp(false);
    await land('a');
    deliveries.handBackQueued();
    expect(writes).toEqual([]);
    expect(undelivered).toHaveLength(2);
  });

  it('hands back nothing as the daemon closes that is being typed, its Enter not yet seen to start a turn', async () => {
    const { deliveries, writes, advance, undelivered } = setup([row('a')]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', undefined, up);
    await deliveries.answer('a', 'Also lint');
    comeUp(true);
    // Drawn, and Enter pressed once its terminal is quiet: no turn has started on it yet.
    await advance(0);
    deliveries.outputSeen('a');
    await advance(150);
    expect(writes).toEqual([
      ['a', 'Also lint'],
      ['a', '\r'],
    ]);
    // Its prompt has it now, its `UserPromptSubmit` still to come.
    deliveries.handBackQueued();
    expect(undelivered).toEqual([]);
  });

  it('keeps on handing back as the daemon closes when one could not be kept', async () => {
    const { deliveries, undelivered } = setup([row('a'), row('b')]);
    for (const id of ['a', 'b']) {
      deliveries.firstPrompt(id, undefined, new Promise<boolean>(() => {}));
      await deliveries.answer(id, `Also lint ${id}`);
    }
    const push = undelivered.push.bind(undelivered);
    let failed = false;
    undelivered.push = (...kept) => {
      if (failed) return push(...kept);
      failed = true;
      throw new Error('disk full');
    };
    expect(() => deliveries.handBackQueued()).not.toThrow();
    expect([...undelivered]).toEqual(['b A message: Also lint b (the daemon shut down before it was up)']);
  });

  it('hands back nothing as the daemon closes that its queue already settled', async () => {
    const a = row('a');
    const { deliveries, land, undelivered } = setup([a]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests', up);
    await deliveries.answer('a', 'Also lint');
    a.ended_at = '2026-10-22T10:00:01Z';
    comeUp(false);
    await land('a');
    deliveries.handBackQueued();
    expect(undelivered).toEqual(['a A message: Also lint (a has ended)']);
  });

  it('hands back what was queued behind a first prompt left unsent, never typing onto it', async () => {
    const { deliveries, writes, advance, undelivered } = setup([row('a')]);
    const { promise: up, resolve: comeUp } = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests', up);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    comeUp(true);
    // No turn starts on it: Enter is pressed again while its prompt holds only it, then it is kept unsent.
    await advance(30_000);
    expect(deliveries.unsent('a')).toBe('Its first prompt');
    expect(writes.map(([, data]) => data)).not.toContain('Also lint');
    expect(undelivered).toEqual([`a A message: Also lint (a message typed at its prompt was never sent)`]);
  });

  it('keeps what was queued for an agent relaunched before it came up for its new session, after that one\'s first prompt', async () => {
    const { deliveries, writes, land, advance, prompt, undelivered } = setup([row('a')]);
    const first = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests', first.promise);
    expect(await deliveries.answer('a', 'Also lint')).toEqual({ queued: true });
    first.resolve(false);
    const second = Promise.withResolvers<boolean>();
    deliveries.firstPrompt('a', 'Fix the tests again', second.promise);
    await land('a');
    expect(writes).toEqual([]);
    expect(deliveries.queuedUntilUp('a')).toBe(1);

    second.resolve(true);
    await land('a');
    prompt.now = 'working';
    deliveries.outputSeen('a');
    await advance(200);
    expect(writes.map(([, data]) => data)).toEqual(['\x1b[200~Fix the tests again\x1b[201~', '\r', 'Also lint', '\r']);
    expect(undelivered).toEqual([]);
  });

  it('types no first prompt once the session it waited on has ended, and takes messages again', async () => {
    const { deliveries, writes, land } = setup([row('a')]);
    deliveries.firstPrompt('a', 'Fix the tests', Promise.resolve(false));
    await land('a');
    expect(writes).toEqual([]);
    expect(deliveries.whyNotUp('a')).toBeUndefined();
  });

  it("types a hand-off at a live agent's prompt and submits it, showing the sender handing off until it lands", async () => {
    const { deliveries, writes, announced, land } = setup([row('from', { name: 'planner' }), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await land('to');
    expect(await delivered).toEqual({ started: true });
    expect(writes.map(([sessionId]) => sessionId)).toEqual(['to', 'to']);
    expect(writes[0]![1]).toContain('the plan');
    expect(writes[1]![1]).toBe('\r');
    expect(announced).toEqual([
      { sessionId: 'from', handingOff: true },
      { sessionId: 'from', handingOff: false },
    ]);
  });

  it('relaunches an ended agent with the hand-off, carrying on its Codex conversation', async () => {
    const { deliveries, writes, relaunches } = setup([row('from'), row('to', { ended_at: '2026-10-15T10:00:00Z', harness_session_id: 'conv' })]);
    expect(await deliveries.deliver('from', 'to', 'plan', 'the plan')).toEqual({ started: true });
    expect(writes).toEqual([]);
    expect(relaunches).toEqual([{ sessionId: 'to', prompt: expect.stringContaining('the plan'), why: 'for a hand-off from from', codexSessionId: 'conv' }]);
  });

  it('holds a hand-off back as busy while the live agent is not ready', async () => {
    const { deliveries, writes } = setup([row('from'), row('to')], 'it was still working');
    expect(await deliveries.deliver('from', 'to', 'plan', 'the plan')).toEqual({ started: false, reason: 'it was still working', busy: true });
    expect(writes).toEqual([]);
  });

  it("forgets a deleted sender's hand-offs still landing", async () => {
    const { deliveries, land } = setup([row('from'), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    expect(deliveries.isHandingOff('from')).toBe(true);
    deliveries.forget('from');
    expect(deliveries.isHandingOff('from')).toBe(false);
    await land('to');
    await delivered;
    expect(deliveries.isHandingOff('from')).toBe(false);
  });

  it("types a scheduled run at a ready agent's prompt as one line, and submits it", async () => {
    const { deliveries, writes, land } = setup([row('a')]);
    expect(deliveries.runScheduled('a', 'Check the build\n\n  then the tests')).toEqual({ started: true });
    await land('a');
    expect(writes).toEqual([['a', 'Check the build then the tests'], ['a', '\r']]);
  });

  it('relaunches an ended agent for its scheduled run', () => {
    const { deliveries, writes, relaunches } = setup([row('a', { ended_at: '2026-10-15T10:00:00Z', harness_session_id: 'conv' })]);
    expect(deliveries.runScheduled('a', 'run')).toEqual({ started: true });
    expect(relaunches).toEqual([{ sessionId: 'a', prompt: 'run', why: 'for its scheduled run', codexSessionId: undefined }]);
    expect(writes).toEqual([]);
  });

  it("wakes a paused agent for its scheduled run in its own conversation, Codex's too, and skips one being paused", () => {
    const paused = setup([row('a', { ended_at: '2026-10-15T10:00:00Z', harness_session_id: 'conv', hibernated_at: '2026-10-15T09:00:00Z' })]);
    expect(paused.deliveries.runScheduled('a', 'run')).toEqual({ started: true });
    expect(paused.relaunches).toEqual([{ sessionId: 'a', prompt: 'run', why: 'for its scheduled run', codexSessionId: 'conv' }]);
    const pausing = setup([row('a', { hibernated_at: '2026-10-15T09:00:00Z' })]);
    expect(pausing.deliveries.runScheduled('a', 'run')).toEqual({ started: false, reason: 'it was being paused' });
    expect(pausing.writes).toEqual([]);
  });

  it('is busy at an agent while a message is being typed or sent to it, its turn not yet started', async () => {
    const { deliveries, land } = setup([row('a')]);
    expect(deliveries.busy('a')).toBe(false);
    const answered = deliveries.answer('a', 'hello');
    expect(deliveries.busy('a')).toBe(true);
    await land('a');
    await answered;
    expect(deliveries.busy('a')).toBe(false);
  });

  it('tells why a scheduled run is not started in an agent not ready, or deleted', () => {
    expect(setup([row('a')], 'it was waiting for you').deliveries.runScheduled('a', 'run')).toEqual({ started: false, reason: 'it was waiting for you' });
    expect(setup([]).deliveries.runScheduled('a', 'run')).toEqual({ started: false, reason: 'the agent has been deleted' });
  });

  it('types an answer after the one still landing, never into it', async () => {
    const { deliveries, writes, land } = setup([row('a')]);
    const both = Promise.all([deliveries.answer('a', 'one'), deliveries.answer('a', 'two')]);
    await flush();
    expect(writes.map(([, data]) => data)).toEqual(['one']);
    await land('a');
    expect(writes.map(([, data]) => data)).toEqual(['one', '\r', 'two']);
    await land('a');
    await both;
    expect(writes.map(([, data]) => data)).toEqual(['one', '\r', 'two', '\r']);
  });
});

describe('submitting what is typed', () => {
  it('presses Enter once the harness has drawn the text and its terminal has gone quiet, however long it draws', async () => {
    const { deliveries, writes, advance } = setup([row('a')]);
    void deliveries.answer('a', 'the plan');
    await flush();
    expect(writes).toEqual([['a', 'the plan']]);
    // A slow machine draws the text in pieces: Enter waits for the last.
    for (let piece = 0; piece < 3; piece += 1) {
      await advance(100);
      deliveries.outputSeen('a');
    }
    await advance(149);
    expect(writes).toHaveLength(1);
    await advance(1);
    expect(writes.at(-1)).toEqual(['a', '\r']);
  });

  it('presses Enter all the same once the longest wait has passed, if the terminal draws nothing', async () => {
    const { deliveries, writes, advance } = setup([row('a')]);
    void deliveries.answer('a', 'the plan');
    await advance(1_999);
    expect(writes).toHaveLength(1);
    await advance(1);
    expect(writes.at(-1)).toEqual(['a', '\r']);
  });

  it('presses Enter again, waiting longer each time, while no turn starts; never types the text again', async () => {
    const { deliveries, writes, advance } = setup([row('from', { name: 'planner' }), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await flush();
    deliveries.outputSeen('to');
    await advance(150);
    // The harness lost that Enter: a second follows a wait, a third twice that.
    await advance(1_000);
    expect(writes.map(([, data]) => data).slice(1)).toEqual(['\r', '\r']);
    await advance(1_999);
    expect(writes).toHaveLength(3);
    deliveries.turnSeen('to');
    expect(await delivered).toEqual({ started: true });
    expect(deliveries.unsent('to')).toBeUndefined();
    expect(writes.filter(([, data]) => data.includes('the plan'))).toHaveLength(1);
  });

  it('presses Enter no more once its turn has started, though no hook said so', async () => {
    const { deliveries, writes, advance, prompt } = setup([row('from'), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await advance(2_000);
    prompt.now = 'moved-on';
    await advance(10_000);
    expect(await delivered).toEqual({ started: true });
    expect(writes.map(([, data]) => data).slice(1)).toEqual(['\r']);
    expect(deliveries.unsent('to')).toBeUndefined();
  });

  it("never presses Enter on a prompt the user started typing at while the text landed: it keeps it unsent instead", async () => {
    const { deliveries, writes, advance, prompt } = setup([row('a')]);
    const answered = deliveries.answer('a', 'the plan');
    await advance(1_000);
    prompt.now = 'typing';
    await advance(1_000);
    expect(await answered).toEqual({ queued: false, unsent: 'you typed at its prompt meanwhile' });
    expect(writes.map(([, data]) => data)).toEqual(['the plan']);
    expect(deliveries.unsent('a')).toBe('A message');
  });

  it('says a message whose last Enter started no turn was not sent, never that it was', async () => {
    const { deliveries, advance } = setup([row('a')]);
    const answered = deliveries.answer('a', 'the plan');
    await advance(2_000 + 1_000 + 2_000 + 4_000);
    expect(await answered).toEqual({ queued: false, unsent: 'no turn started on it after 3 presses of Enter' });
    expect(deliveries.unsent('a')).toBe('A message');
  });

  it('says a message whose turn started was sent', async () => {
    const { deliveries, land } = setup([row('a')]);
    const answered = deliveries.answer('a', 'the plan');
    await land('a');
    expect(await answered).toEqual({ queued: false });
  });

  it("keeps a hand-off still unsent after the last Enter as the agent's unsent message, and types nothing more after it", async () => {
    const { deliveries, writes, advance, announced } = setup([row('from', { name: 'planner' }), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await advance(2_000 + 1_000 + 2_000 + 4_000);
    expect(await delivered).toEqual({ started: true, unsent: true });
    expect(writes.map(([, data]) => data).slice(1)).toEqual(['\r', '\r', '\r']);
    expect(deliveries.unsent('to')).toBe('Hand-off from planner');
    expect(announced).toContainEqual({ sessionId: 'to', handingOff: false });

    const reason = 'a message typed at its prompt was never sent';
    expect(await deliveries.deliver('from', 'to', 'plan', 'more')).toEqual({ started: false, reason, busy: true });
    expect(deliveries.runScheduled('to', 'run')).toEqual({ started: false, reason });
    await expect(deliveries.answer('to', 'hello')).rejects.toThrow('to has a message typed at its prompt that was never sent: send or clear it first');
    expect(writes).toHaveLength(4);
  });

  it('answers a hand-off queued behind one that ends unsent as busy, typing nothing, so its edge queues it', async () => {
    const { deliveries, writes, advance } = setup([row('from'), row('other'), row('to')]);
    const first = deliveries.deliver('from', 'to', 'plan', 'the plan');
    const second = deliveries.deliver('other', 'to', 'review', 'the review');
    await advance(9_000);
    expect(await first).toEqual({ started: true, unsent: true });
    expect(await second).toEqual({ started: false, reason: 'a message typed at its prompt was never sent', busy: true });
    expect(writes.filter(([, data]) => data.includes('the review'))).toEqual([]);
  });

  it('answers a hand-off queued behind one whose turn started as busy: it waits for that turn to end', async () => {
    const { deliveries, writes, ready, land } = setup([row('from'), row('other'), row('to')]);
    const first = deliveries.deliver('from', 'to', 'plan', 'the plan');
    const second = deliveries.deliver('other', 'to', 'review', 'the review');
    await flush();
    ready.why = 'it was still working';
    await land('to');
    expect(await first).toEqual({ started: true });
    expect(await second).toEqual({ started: false, reason: 'it was still working', busy: true });
    expect(writes.filter(([, data]) => data.includes('the review'))).toEqual([]);
  });

  it('keeps what it typed unsent when the prompt moved on before the first Enter: nothing submitted it', async () => {
    const { deliveries, writes, advance, prompt } = setup([row('from', { name: 'planner' }), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await advance(1_000);
    // A subagent's permission prompt came up while the text landed.
    prompt.now = 'moved-on';
    await advance(1_000);
    expect(await delivered).toEqual({ started: true, unsent: true });
    expect(writes.map(([, data]) => data)).toEqual([expect.stringContaining('the plan')]);
    expect(deliveries.unsent('to')).toBe('Hand-off from planner');
  });

  it("presses Enter once on an answer to an agent found working, queueing it for after its turn as the user's own would", async () => {
    const { deliveries, writes, advance, prompt } = setup([row('a')]);
    prompt.now = 'working';
    const answered = deliveries.answer('a', 'and the tests');
    await advance(2_000);
    expect(await answered).toEqual({ queued: false, inTurn: true });
    await advance(10_000);
    expect(writes.map(([, data]) => data)).toEqual(['and the tests', '\r']);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('queues a hand-off with one Enter for after the turn its agent started while it landed, as an answer is', async () => {
    const { deliveries, writes, advance, prompt } = setup([row('from'), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    await advance(1_000);
    prompt.now = 'working';
    await advance(1_000);
    expect(await delivered).toEqual({ started: true });
    expect(writes.map(([, data]) => data)).toEqual([expect.stringContaining('the plan'), '\r']);
    expect(deliveries.unsent('to')).toBeUndefined();

    // That turn ends and none starts on it: Enter is pressed again, and it is unsent only if still none does.
    prompt.now = 'at-prompt';
    deliveries.turnEnded('to', true);
    await advance(1_000);
    deliveries.turnSeen('to');
    await advance(1_000);
    expect(writes.map(([, data]) => data)).toEqual([expect.stringContaining('the plan'), '\r', '\r']);
    expect(deliveries.unsent('to')).toBeUndefined();
  });

  it('never presses Enter again on a prompt the user is typing at: it would send their words', async () => {
    const { deliveries, writes, advance, prompt, notSent } = setup([row('a')]);
    const answered = deliveries.answer('a', 'the plan');
    await advance(2_000);
    prompt.now = 'typing';
    await advance(1_000);
    await answered;
    expect(writes.map(([, data]) => data)).toEqual(['the plan', '\r']);
    expect(deliveries.unsent('a')).toBe('A message');
    // The board's Send refuses a prompt the user typed at: they are told to see to it in its terminal.
    expect(notSent).toEqual([['a', 'A message', 'you typed at its prompt meanwhile', true]]);
  });
});

describe('an answer that waited its turn', () => {
  it('types nothing once a permission prompt came up while it waited, where its keys would answer that, and says why', async () => {
    const { deliveries, writes, advance, prompt, shown } = setup([row('from'), row('a')]);
    const delivered = deliveries.deliver('from', 'a', 'plan', 'the plan');
    const answered = deliveries.answer('a', '1');
    const refused = expect(answered).rejects.toMatchObject({ message: 'a needs permission first' });
    await flush();
    deliveries.outputSeen('a');
    await advance(150);
    // The hand-off's turn starts, and asks for permission straight away.
    prompt.now = 'moved-on';
    shown.state = 'needs-permission';
    deliveries.turnSeen('a');
    expect(await delivered).toEqual({ started: true });
    await refused;
    await advance(10_000);
    expect(writes.map(([, data]) => data)).toEqual([expect.stringContaining('the plan'), '\r']);
  });

  it('types nothing at a rate-limited agent, whose harness may show a menu where Enter would pick one', async () => {
    const { deliveries, writes, prompt, shown } = setup([row('a')]);
    prompt.now = 'moved-on';
    shown.state = 'rate-limited';
    await expect(deliveries.answer('a', 'carry on')).rejects.toMatchObject({ message: 'a is rate-limited: answer it in its terminal, or Continue on credits' });
    expect(writes).toEqual([]);
  });

  it('types nothing once a question came up while it waited', async () => {
    const { deliveries, writes, advance, prompt, shown } = setup([row('from'), row('a')]);
    const delivered = deliveries.deliver('from', 'a', 'plan', 'the plan');
    const answered = deliveries.answer('a', 'yes');
    const refused = expect(answered).rejects.toMatchObject({
      message: 'a is waiting on a question or dialog of its own, "Which branch should I use?": answer it in its terminal',
    });
    await flush();
    deliveries.outputSeen('a');
    await advance(150);
    prompt.now = 'moved-on';
    shown.state = 'waiting';
    shown.lastMessage = 'Which branch should I use?';
    deliveries.turnSeen('a');
    await delivered;
    await refused;
    expect(writes).toHaveLength(2);
  });

  it('is typed as before while the agent works through the turn it waited behind: its Enter queues it', async () => {
    const { deliveries, writes, advance, prompt, shown } = setup([row('from'), row('a')]);
    const delivered = deliveries.deliver('from', 'a', 'plan', 'the plan');
    const answered = deliveries.answer('a', 'and the tests');
    await flush();
    deliveries.outputSeen('a');
    await advance(150);
    prompt.now = 'working';
    shown.state = 'running';
    deliveries.turnSeen('a');
    await delivered;
    await advance(2_000);
    await answered;
    expect(writes.map(([, data]) => data)).toEqual([expect.stringContaining('the plan'), '\r', 'and the tests', '\r']);
  });
});

describe('an answer queued mid-turn', () => {
  /** An agent at work, sent `text`: typed, and its one Enter pressed for its harness to queue. */
  const queuedAnswer = async (text = 'and the tests') => {
    const each = setup([row('from', { name: 'planner' }), row('a')]);
    each.prompt.now = 'working';
    each.shown.state = 'running';
    const answered = each.deliveries.answer('a', text);
    await each.advance(2_000);
    await answered;
    return each;
  };

  it('is taken up when its harness submits it after the turn: nothing more is pressed', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    // Hooks of the turn under way are no news of it, nor is its own prompt's, late.
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'Run the tests');
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    await advance(500);
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'and the tests');
    await advance(20_000);
    expect(writes.map(([, data]) => data)).toEqual(['and the tests', '\r']);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is taken up when its harness takes it into the turn under way: the turn ends with nothing left to press', async () => {
    const { deliveries, writes, advance } = await queuedAnswer();
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'and the tests');
    deliveries.turnEnded('a', true);
    await advance(20_000);
    expect(writes).toHaveLength(2);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is taken up when its harness submits it pasted, its line breaks kept', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer('first line\nsecond line');
    expect(writes[0]![1]).toBe('\x1b[200~first line\rsecond line\x1b[201~');
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'first line\nsecond line');
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    await advance(20_000);
    expect(writes).toHaveLength(2);
  });

  it('gets Enter again once the turn has ended with no turn of its own started: a slow harness lost the first', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    await advance(1_000);
    expect(writes.map(([, data]) => data)).toEqual(['and the tests', '\r', '\r']);
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'and the tests');
    await advance(20_000);
    expect(writes).toHaveLength(3);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is kept unsent once no Enter starts a turn on it, so the next hand-off types nothing onto it', async () => {
    const { deliveries, writes, advance, prompt, shown } = await queuedAnswer();
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    shown.state = 'idle';
    await advance(1_000 + 1_000 + 2_000 + 4_000);
    expect(writes.map(([, data]) => data)).toEqual(['and the tests', '\r', '\r', '\r', '\r']);
    expect(deliveries.unsent('a')).toBe('A message');
    expect(await deliveries.deliver('from', 'a', 'plan', 'the plan')).toEqual({ started: false, reason: 'a message typed at its prompt was never sent', busy: true });
    expect(writes).toHaveLength(5);
  });

  it('keeps a hand-off that arrives as the turn ends waiting behind it, then busy', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    const delivered = deliveries.deliver('from', 'a', 'plan', 'the plan');
    await advance(1_000 + 1_000 + 2_000 + 4_000);
    expect(await delivered).toEqual({ started: false, reason: 'a message typed at its prompt was never sent', busy: true });
    expect(writes.filter(([, data]) => data.includes('the plan'))).toEqual([]);
  });

  it('is kept unsent at once, with no Enter, when its turn is interrupted: the user may want it back', async () => {
    const { deliveries, writes, advance } = await queuedAnswer();
    deliveries.turnEnded('a', false);
    expect(deliveries.unsent('a')).toBe('A message');
    // Codex's own Interrupt hook, after the board's interrupt, is no news it was taken.
    deliveries.turnSeen('a', true);
    deliveries.turnEnded('a', false);
    expect(deliveries.unsent('a')).toBe('A message');
    await advance(20_000);
    expect(writes).toHaveLength(2);
    // Its harness submits it after all.
    deliveries.turnSeen('a');
    deliveries.promptSubmitted('a', 'and the tests');
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is kept unsent at once, with no Enter, when its turn hits a rate limit: its harness may show a menu there', async () => {
    const { deliveries, writes, advance, prompt, notSent } = await queuedAnswer();
    deliveries.turnEnded('a', false, 'rate-limited');
    prompt.now = 'moved-on';
    expect(deliveries.unsent('a')).toBe('A message');
    await advance(20_000);
    expect(writes).toHaveLength(2);
    // The user is told: only their Send moves it on once the limit lifts.
    expect(notSent).toEqual([['a', 'A message', 'its turn hit a rate limit', false]]);
  });

  it('is kept unsent when the user interrupts its turn in the terminal, until they submit or clear what is there', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    deliveries.typed('a', '\x1b');
    expect(deliveries.unsent('a')).toBe('A message');
    prompt.now = 'at-prompt';
    deliveries.turnEnded('a', true);
    await advance(20_000);
    expect(writes).toHaveLength(2);
    deliveries.typed('a', '\r');
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is the user’s once they press Enter or Ctrl-U in the terminal: their turn’s end presses nothing for it', async () => {
    for (const key of ['\r', '\x15']) {
      const { deliveries, writes, advance, prompt } = await queuedAnswer();
      deliveries.typed('a', key);
      prompt.now = 'at-prompt';
      deliveries.turnEnded('a', true);
      await advance(20_000);
      expect(writes).toHaveLength(2);
      expect(deliveries.unsent('a')).toBeUndefined();
    }
  });

  it('is gone once a prompt of the user’s own starts a turn at its prompt: the next turn’s end presses nothing for it', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    // Interrupted in the terminal by some key no one could tell, the text came back, and the user rewrote it.
    prompt.now = 'at-prompt';
    deliveries.promptSubmitted('a', 'and the lint');
    deliveries.turnSeen('a');
    deliveries.turnEnded('a', true);
    await advance(20_000);
    expect(writes).toHaveLength(2);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is taken up only by a prompt that is it, or ends with it: a short answer is not in every prompt', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer('1');
    deliveries.promptSubmitted('a', 'Run step 1');
    deliveries.promptSubmitted('a', '1st thing');
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    await advance(1_000);
    expect(writes.map(([, data]) => data)).toEqual(['1', '\r', '\r']);

    const together = await queuedAnswer('first');
    const second = together.deliveries.answer('a', 'second');
    await together.advance(2_000);
    await second;
    together.deliveries.promptSubmitted('a', 'first\nsecond');
    together.deliveries.turnEnded('a', true);
    together.prompt.now = 'at-prompt';
    await together.advance(20_000);
    expect(together.writes).toHaveLength(4);
  });

  it('never calls what the user is typing at its prompt, as its turn ends, the board’s unsent message', async () => {
    const { deliveries, writes, advance, prompt } = await queuedAnswer();
    deliveries.turnEnded('a', true);
    prompt.now = 'typing';
    await advance(20_000);
    expect(writes).toHaveLength(2);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('counts the lines of every message queued in the turn, so Clear clears them all', async () => {
    const { deliveries, advance, prompt, writes } = await queuedAnswer('first');
    const second = deliveries.answer('a', 'second');
    await advance(2_000);
    await second;
    deliveries.turnEnded('a', false);
    prompt.now = 'at-prompt';
    expect(deliveries.clear('a')).toBe('\x15\x7f\x15');
    expect(writes.at(-1)).toEqual(['a', '\x15\x7f\x15']);
  });

  it('is forgotten when the session ends', async () => {
    const { deliveries, advance, prompt } = await queuedAnswer();
    deliveries.ended('a');
    deliveries.turnEnded('a', true);
    prompt.now = 'at-prompt';
    await advance(20_000);
    expect(deliveries.unsent('a')).toBeUndefined();
  });
});

describe('an unsent message', () => {
  /** Deliveries whose agent `a` holds a scheduled run that was never sent. */
  const unsentOn = async () => {
    const made = setup([row('from'), row('a')]);
    void made.deliveries.runScheduled('a', 'run');
    await made.advance(9_000);
    expect(made.deliveries.unsent('a')).toBe('A scheduled run');
    made.writes.length = 0;
    return made;
  };

  it("is sent on the user's Send, which keeps it unsent, so nothing is typed onto it, until its turn starts", async () => {
    const { deliveries, writes, advance } = await unsentOn();
    const sent = deliveries.send('a');
    await flush();
    expect(writes).toEqual([['a', '\r']]);
    // A hand-off arriving while Send waits finds the prompt still holding the run.
    expect(await deliveries.deliver('from', 'a', 'plan', 'the plan')).toEqual({
      started: false,
      reason: 'a message typed at its prompt was never sent',
      busy: true,
    });
    await expect(deliveries.send('a')).rejects.toThrow("a's unsent message is being sent");
    await advance(1_000);
    expect(writes).toEqual([['a', '\r'], ['a', '\r']]);
    deliveries.turnSeen('a');
    expect(await sent).toEqual({ started: true });
    expect(deliveries.unsent('a')).toBeUndefined();
    expect(writes.filter(([, data]) => data.includes('the plan'))).toEqual([]);
  });

  it('is taken as gone once Send starts no turn either: the prompt holds nothing to send', async () => {
    const { deliveries, writes, advance } = await unsentOn();
    const sent = deliveries.send('a');
    await advance(1_000 + 2_000 + 4_000);
    expect(await sent).toEqual({ started: false, why: 'no turn started on it after 3 presses of Enter' });
    expect(writes.map(([, data]) => data)).toEqual(['\r', '\r', '\r']);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it("stays unsent when an orchestrator's Send starts no turn: it sees no prompt, and Enters can be lost", async () => {
    const { deliveries, writes, advance } = await unsentOn();
    const sent = deliveries.send('a', false);
    await advance(1_000 + 2_000 + 4_000);
    expect(await sent).toEqual({ started: false, why: 'no turn started on it after 3 presses of Enter' });
    expect(writes.map(([, data]) => data)).toEqual(['\r', '\r', '\r']);
    expect(deliveries.unsent('a')).toBe('A scheduled run');
  });

  it('types an answer that came while Send waited once its turn starts: Send settles first, in its own step', async () => {
    const { deliveries, writes, land } = await unsentOn();
    const sent = deliveries.send('a');
    await flush();
    const answered = deliveries.answer('a', 'and the tests');
    deliveries.turnSeen('a');
    await sent;
    expect(deliveries.unsent('a')).toBeUndefined();
    await land('a');
    await answered;
    expect(writes.map(([, data]) => data)).toEqual(['\r', 'and the tests', '\r']);
  });

  it('stays unsent when the user types at its prompt while Send waits: what is there now is theirs too', async () => {
    const { deliveries, advance, prompt } = await unsentOn();
    const sent = deliveries.send('a');
    await advance(500);
    prompt.now = 'typing';
    await advance(500);
    expect(await sent).toEqual({ started: false, why: 'you typed at its prompt meanwhile' });
    expect(deliveries.unsent('a')).toBe('A scheduled run');
  });

  it('is never sent from the board on a prompt the user is typing at, nor sent or cleared on one not at its prompt', async () => {
    const { deliveries, writes, prompt } = await unsentOn();
    prompt.now = 'typing';
    await expect(deliveries.send('a')).rejects.toThrow("you are typing in a's terminal");
    prompt.now = 'moved-on';
    await expect(deliveries.send('a')).rejects.toThrow('a is not at its prompt');
    expect(() => deliveries.clear('a')).toThrow('a is not at its prompt');
    expect(writes).toEqual([]);
  });

  it("is never sent or cleared for an orchestrator while the user is typing there: their words would go with it", async () => {
    const { deliveries, writes, prompt } = await unsentOn();
    prompt.now = 'typing';
    await expect(deliveries.send('a', false)).rejects.toThrow("the user is typing in a's terminal");
    expect(() => deliveries.clear('a', false)).toThrow("the user is typing in a's terminal");
    expect(writes).toEqual([]);
    expect(deliveries.unsent('a')).toBe('A scheduled run');
  });

  it('is cleared on Clear with what the user typed there too, so a draft they emptied with Backspace never blocks it', async () => {
    const { deliveries, writes, prompt } = await unsentOn();
    prompt.now = 'typing';
    expect(deliveries.clear('a')).toBe('\x15');
    expect(writes).toEqual([['a', '\x15']]);
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('clears every line of a message of several lines on Clear, joining each to the one above', async () => {
    const { deliveries, writes, advance } = setup([row('a')]);
    void deliveries.answer('a', 'one\ntwo\nthree');
    await advance(9_000);
    expect(deliveries.unsent('a')).toBe('A message');
    deliveries.clear('a');
    expect(writes.at(-1)).toEqual(['a', '\x15\x7f\x15\x7f\x15']);
  });

  it("is cleared on the user's Clear, which clears the line at its prompt, so deliveries type at it again", async () => {
    const { deliveries, writes, land } = await unsentOn();
    expect(deliveries.clear('a')).toBe('\x15');
    expect(writes).toEqual([['a', '\x15']]);
    expect(deliveries.unsent('a')).toBeUndefined();
    expect(() => deliveries.clear('a')).toThrow('a has no unsent message at its prompt');
    const delivered = deliveries.deliver('from', 'a', 'plan', 'the plan');
    await land('a');
    expect(await delivered).toEqual({ started: true });
  });

  it("is forgotten once a hook of its turn says it was taken, even with its UserPromptSubmit lost", async () => {
    const { deliveries } = await unsentOn();
    // A short turn's Stop, its prompt hook lost on the way.
    deliveries.turnSeen('a');
    expect(deliveries.unsent('a')).toBeUndefined();
  });

  it('is forgotten once its prompt is submitted or cleared in its terminal, or its session ends', async () => {
    const typedOn = (await unsentOn()).deliveries;
    typedOn.typed('a', ' and the tests');
    expect(typedOn.unsent('a')).toBe('A scheduled run');
    typedOn.typed('a', '\x15');
    expect(typedOn.unsent('a')).toBeUndefined();
    const ended = (await unsentOn()).deliveries;
    ended.ended('a');
    expect(ended.unsent('a')).toBeUndefined();
  });
});

describe('messages waiting for a turn to end', () => {
  /** A message kept until the agent's turn ends, recording how it went: `typing`, then `started` or `not started`. */
  const waiting = (text: string, heard: string[]) => ({
    text,
    typing: () => void heard.push(`${text}: typing`),
    settled: (started: boolean) => void heard.push(`${text}: ${started ? 'started' : 'not started'}`),
  });

  it('types the oldest at a ready prompt, counting it until it is typed, and keeps the rest for the next turn to end', async () => {
    const { deliveries, writes, land } = setup([row('a')]);
    const heard: string[] = [];
    deliveries.queueAfterTurn('a', waiting('First', heard));
    deliveries.queueAfterTurn('a', waiting('Second', heard));
    deliveries.deliverAfterTurn('a');
    // Being typed, it is still counted: a send meanwhile goes behind it.
    expect(deliveries.waitingAfterTurn('a')).toBe(2);
    await land('a');
    expect(writes).toEqual([
      ['a', 'First'],
      ['a', '\r'],
    ]);
    expect(heard).toEqual(['First: typing', 'First: started']);
    expect(deliveries.waitingAfterTurn('a')).toBe(1);
  });

  it('keeps one first in line when the agent goes to work before it is typed', async () => {
    const { deliveries, writes, ready, advance } = setup([row('a')]);
    const heard: string[] = [];
    deliveries.queueAfterTurn('a', waiting('First', heard));
    // A crew flag is being typed at it first; by the time that is done, it is at work.
    void deliveries.tell('a', 'A crew flag');
    deliveries.deliverAfterTurn('a');
    ready.why = 'it is at work';
    await advance(10_000);
    expect(writes.filter(([, data]) => data === 'First')).toEqual([]);
    expect(heard).toEqual(['First: typing', 'First: not started']);
    expect(deliveries.waitingAfterTurn('a')).toBe(1);

    ready.why = undefined;
    deliveries.deliverAfterTurn('a');
    await advance(200);
    expect(writes.filter(([, data]) => data === 'First')).toHaveLength(1);
  });

  it('hands back the one being typed, with those behind it, when its session ends or the daemon closes, settling each once', async () => {
    for (const end of ['session', 'daemon'] as const) {
      const a = row('a');
      const { deliveries, undelivered, land } = setup([a]);
      const heard: string[] = [];
      deliveries.queueAfterTurn('a', waiting('First', heard));
      deliveries.queueAfterTurn('a', waiting('Second', heard));
      deliveries.deliverAfterTurn('a');
      if (end === 'session') {
        a.ended_at = '2026-10-22T10:00:01Z';
        deliveries.ended('a');
      } else {
        deliveries.handBackQueued();
      }
      await land('a');
      const reason = end === 'session' ? 'its session ended before its turn did' : 'the daemon shut down before its turn ended';
      expect(undelivered).toEqual([`a A message: First (${reason})`, `a A message: Second (${reason})`]);
      expect(heard).toEqual(['First: typing', 'First: not started', 'Second: not started']);
      expect(deliveries.waitingAfterTurn('a')).toBe(0);
    }
  });

  it('hands back one that could not be typed, saying so plainly, and goes on to the next', async () => {
    const { deliveries, undelivered, failing, land, writes } = setup([row('a')]);
    const heard: string[] = [];
    deliveries.queueAfterTurn('a', waiting('First', heard));
    deliveries.queueAfterTurn('a', waiting('Second', heard));
    failing.write = new Error('write EIO');
    deliveries.deliverAfterTurn('a');
    await land('a');
    expect(undelivered).toEqual(['a A message: First (it could not be typed)']);
    expect(heard).toEqual(['First: typing', 'First: not started']);
    expect(deliveries.waitingAfterTurn('a')).toBe(1);

    failing.write = undefined;
    deliveries.deliverAfterTurn('a');
    await land('a');
    expect(writes).toEqual([
      ['a', 'Second'],
      ['a', '\r'],
    ]);
  });
});

describe('continuing on credits', () => {
  const ESC = '\x1b';
  const menu = (order: 'stop-first' | 'credits-first') => drawRateLimitMenu(rateLimitMenuRows(order)).map((line) => line.replace(/[\u2500-\u257f]/g, ' ').trim());

  /** A rate-limited agent `a` whose screen reads as each of `screens` in turn, the last one for good. */
  function limited(...screens: string[][]) {
    const set = setup([row('a')]);
    set.prompt.now = 'moved-on';
    set.shown.state = 'rate-limited';
    const screen = () => Promise.resolve(screens.length > 1 ? screens.shift()! : screens[0]!);
    return { ...set, screen, data: () => set.writes.map(([, data]) => data) };
  }

  it("closes Claude's menu with Escape, picking no row, types continue at the prompt and confirms its turn started", async () => {
    const { deliveries, data, screen, advance } = limited(menu('credits-first'), ['API Error: 429', '>']);
    const continued = deliveries.continueOnCredits('a', screen);
    await advance(2_000);
    await advance(2_000);
    deliveries.turnSeen('a');
    await continued;
    expect(data()).toEqual([ESC, 'continue', '\r']);
  });

  it('presses Enter on the continue Claude put at its prompt itself, typing nothing', async () => {
    const { deliveries, data, screen, advance } = limited(["You've hit your limit · resets 3pm", '> continue']);
    const continued = deliveries.continueOnCredits('a', screen);
    await advance(10);
    deliveries.turnSeen('a');
    await continued;
    expect(data()).toEqual(['\r']);
  });

  it('presses Escape again while the menu stays up, as it takes no keys just after it opens', async () => {
    // Still up after the first Escape, and as the second is due.
    const { deliveries, data, screen, advance } = limited(menu('stop-first'), menu('stop-first'), menu('stop-first'), ['> continue']);
    const continued = deliveries.continueOnCredits('a', screen);
    await advance(2_000);
    await advance(1_000);
    await advance(2_000);
    deliveries.turnSeen('a');
    await continued;
    expect(data()).toEqual([ESC, ESC, '\r']);
  });

  it('gives up, saying so, on a menu that never closes, never pressing Enter on it', async () => {
    const { deliveries, data, screen, advance } = limited(menu('stop-first'));
    const refused = expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: "a's rate-limit menu did not close: answer it in its terminal" });
    await advance(10_000);
    await refused;
    expect(data()).toEqual([ESC, ESC, ESC]);
  });

  it('presses Escape no more once a turn started meanwhile, which Escape would interrupt', async () => {
    const { deliveries, data, screen, advance, shown } = limited(menu('stop-first'));
    const refused = expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: 'a is not rate-limited: only a turn its usage limit stopped continues on credits' });
    await advance(2_100);
    // The user carried on in its terminal before the next Escape.
    shown.state = 'thinking';
    await advance(10_000);
    await refused;
    expect(data()).toEqual([ESC]);
  });

  it('presses Escape no more once the menu closed meanwhile, and goes on at the prompt', async () => {
    const { deliveries, data, screen, advance } = limited(menu('stop-first'), menu('stop-first'), ['> continue']);
    const continued = deliveries.continueOnCredits('a', screen);
    await advance(2_000);
    await advance(1_000);
    deliveries.turnSeen('a');
    await continued;
    expect(data()).toEqual([ESC, '\r']);
  });

  it('never takes a menu whose title is off screen for a prompt, so Enter never lands on its usage-credits row', async () => {
    // A short terminal: the box's top and its title scrolled off; the pointer's row looks like a prompt.
    const cutOff = menu('credits-first').filter((line) => !line.includes('What do you want to do?'));
    const { deliveries, data, screen, advance } = limited(cutOff);
    const refused = expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: "a's rate-limit menu did not close: answer it in its terminal" });
    await advance(10_000);
    await refused;
    expect(data()).not.toContain('\r');
    expect(data()).not.toContain('continue');
  });

  it('types nothing at a screen showing neither its menu nor its prompt, and says what it shows', async () => {
    const { deliveries, data, screen } = limited(['Opening your options…']);
    await expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({
      message: 'a shows neither its rate-limit menu nor its prompt (Opening your options…): answer it in its terminal',
    });
    expect(data()).toEqual([]);
  });

  it('types nothing onto other text at its prompt, which continue would run on from', async () => {
    const { deliveries, data, screen } = limited(['> and the tests']);
    await expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: "a's prompt holds other text (and the tests): answer it in its terminal" });
    expect(data()).toEqual([]);
  });

  it('presses Enter again while no turn starts, then says none did', async () => {
    const { deliveries, data, screen, advance } = limited(['> continue']);
    const refused = expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: "no turn started at a's prompt on continue: see its terminal" });
    await advance(7_000);
    await refused;
    expect(data()).toEqual(['\r', '\r', '\r']);
  });

  it('refuses a second ask queued behind the first once its turn has started, typing nothing more', async () => {
    const { deliveries, data, screen, advance, shown } = limited(['> continue'], ['>']);
    const first = deliveries.continueOnCredits('a', screen);
    const second = deliveries.continueOnCredits('a', screen);
    const refused = expect(second).rejects.toMatchObject({ message: 'a is not rate-limited: only a turn its usage limit stopped continues on credits' });
    await advance(10);
    shown.state = 'thinking';
    deliveries.turnSeen('a');
    await first;
    await refused;
    await advance(5_000);
    expect(data()).toEqual(['\r']);
  });

  it('is refused to an agent its usage limit did not stop, or the user is typing at', async () => {
    const { deliveries, screen, shown, prompt, data } = limited(['> continue']);
    prompt.now = 'typing';
    await expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: "you are typing in a's terminal" });
    shown.state = 'idle';
    await expect(deliveries.continueOnCredits('a', screen)).rejects.toMatchObject({ message: 'a is not rate-limited: only a turn its usage limit stopped continues on credits' });
    expect(data()).toEqual([]);
  });
});
