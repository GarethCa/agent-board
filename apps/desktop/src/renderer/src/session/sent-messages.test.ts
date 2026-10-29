import { describe, expect, test, vi } from 'vitest';
import type { Agent, ChatEntry } from '@agent-board/daemon/protocol';
import type { Transcript } from './chat';
import { createSentMessages, sentLabel, settle, type SentMessage } from './sent-messages';

const user = (text: string): ChatEntry => ({ kind: 'user', text });
const transcript = (entries: ChatEntry[], first = 0, generation = 1): Transcript => ({ status: 'ok', generation, first, earlier: first > 0, entries });
const sent = (text: string, after: SentMessage['after'] = { generation: 1, end: 0 }, more: Partial<SentMessage> = {}): SentMessage => ({
  id: text,
  text,
  images: [],
  after,
  status: 'sent',
  midTurn: false,
  turns: 0,
  command: false,
  ...more,
});
const waiting = (messages: SentMessage[], read: Transcript | undefined) => settle(messages, read).waiting;

describe('which sent messages the transcript has yet to show', () => {
  test("a message goes once the transcript has a copy written after it was sent, but not for an earlier one's", () => {
    const yes = sent('yes', { generation: 1, end: 2 });
    expect(waiting([yes], transcript([user('yes'), user('no')]))).toEqual([yes]);
    expect(settle([yes], transcript([user('yes'), user('no'), user('yes')]))).toEqual({ waiting: [], confirmed: [{ id: 'yes', at: { generation: 1, end: 3 } }] });
  });

  test('a copy is the whole message: one that only mentions its words, or adds to them, is not', () => {
    const ok = sent('ok');
    expect(waiting([ok], transcript([user('Ada says the build is ok now'), user('ok, the PR is ready'), user('yesterday')]))).toEqual([ok]);
    expect(waiting([ok], transcript([user('  ok\n')]))).toEqual([]);
  });

  test('the same message sent twice needs two copies, however often the chat settles it', () => {
    const messages = createSentMessages(() => Promise.resolve({ queued: false }));
    messages.read('s', { generation: 1, end: 1 });
    void messages.send('s', 'yes', [], true);
    void messages.send('s', 'yes', [], true);
    // The first copy comes: it confirms the first, which goes, and the chat settles again with the same transcript.
    const one = transcript([user('Earlier'), user('yes')]);
    for (let round = 0; round < 3; round += 1) messages.confirm('s', settle(messages.get('s'), one).confirmed);
    expect(messages.get('s')).toHaveLength(1);
    messages.confirm('s', settle(messages.get('s'), transcript([user('Earlier'), user('yes'), user('yes')])).confirmed);
    expect(messages.get('s')).toEqual([]);
  });

  test("two sent in one turn may come as one message; spacing, a paste's wrapper and an image's path don't count", () => {
    const one = sent('Fix the TODO', undefined, { id: '1' });
    const two = sent('Add   a\ntest', undefined, { id: '2' });
    expect(settle([one, two], transcript([user('Fix the TODO\nAdd a test')])).confirmed).toEqual([
      { id: '1', at: { generation: 1, end: 1 } },
      { id: '2', at: { generation: 1, end: 1 } },
    ]);
    const pasted = sent('see\nline 1\nline 2');
    expect(waiting([pasted], transcript([user('see\n<pasted_content id="x">\nline 1\nline 2\n</pasted_content id="x">')]))).toEqual([]);
    const image = sent("Why this? '/tmp/shot 1.png'", undefined, { images: ["'/tmp/shot 1.png'"] });
    expect(waiting([image], transcript([user('Why this? [Image #1]')]))).toEqual([]);
    const onlyImage = sent("'/tmp/a.png'", undefined, { images: ["'/tmp/a.png'"] });
    expect(waiting([onlyImage], transcript([user('[Image #1]')]))).toEqual([]);
  });

  test("the agent's own words and tool results never stand in for a message", () => {
    const yes = sent('yes');
    expect(waiting([yes], transcript([{ kind: 'assistant', text: 'yes' }, { kind: 'tool-result', id: 'a', output: 'yes', isError: false }]))).toEqual([yes]);
  });

  test('a command is never matched: the harness keeps it out of the conversation', () => {
    const compact = sent('/compact', undefined, { command: true });
    expect(waiting([compact], transcript([user('/compact')]))).toEqual([compact]);
  });

  test('one not placed in the transcript the chat has now (sent before its first read, or read afresh since) waits', () => {
    expect(waiting([sent('yes', undefined)], transcript([user('yes')]))).toEqual([]);
    const unplaced = sent('yes', null);
    const older = sent('yes', { generation: 1, end: 0 });
    expect(waiting([unplaced], transcript([user('yes')]))).toEqual([unplaced]);
    expect(waiting([older], transcript([user('yes')], 0, 2))).toEqual([older]);
    expect(waiting([older], undefined)).toEqual([older]);
    expect(waiting([older], { status: 'none', generation: 0, first: 0, earlier: false, entries: [] })).toEqual([older]);
  });
});

describe('placing sent messages in the transcript the chat reads', () => {
  test("one sent before the chat's first read, or from an earlier generation, is placed at the end of what it reads next", () => {
    const messages = createSentMessages(() => Promise.resolve({ queued: false }));
    void messages.send('s', 'yes', [], false);
    expect(messages.get('s')[0]!.after).toBeNull();
    messages.read('s', { generation: 4, end: 7 });
    expect(messages.get('s')[0]!.after).toEqual({ generation: 4, end: 7 });
    messages.read('s', { generation: 5, end: 3 });
    expect(messages.get('s')[0]!.after).toEqual({ generation: 5, end: 3 });
    messages.read('s', { generation: 5, end: 9 });
    expect(messages.get('s')[0]!.after).toEqual({ generation: 5, end: 3 });
  });

  test('one sent while there was no transcript is placed at the start of the first one read', () => {
    const messages = createSentMessages(() => Promise.resolve({ queued: true }));
    messages.read('s', { generation: 0, end: 0 });
    void messages.send('s', 'yes', [], false);
    messages.read('s', { generation: 8, end: 2 });
    expect(messages.get('s')[0]!.after).toEqual({ generation: 8, end: 0 });
  });
});

describe("a sent message's line, until the transcript shows it", () => {
  const agent = (more: Partial<Agent> = {}) =>
    ({ harness: 'claude', endedAt: null, state: 'idle', queuedUntilUp: 0, undelivered: [], ...more }) as Pick<Agent, 'harness' | 'endedAt' | 'state' | 'queuedUntilUp' | 'undelivered'>;

  test('sending; queued while the turn it was sent into goes on; waiting while the session starts', () => {
    expect(sentLabel(sent('a', undefined, { status: 'sending' }), agent())).toBe('sending…');
    expect(sentLabel(sent('a'), agent())).toBe('sending…');
    // Claude takes it at the turn's next step; Codex once the turn ends.
    expect(sentLabel(sent('a', undefined, { midTurn: true }), agent({ state: 'running' }))).toBe('queued: taken at its next step');
    expect(sentLabel(sent('a', undefined, { midTurn: true }), agent({ state: 'running', harness: 'codex' }))).toBe('queued: delivered when the turn ends');
    expect(sentLabel(sent('a', undefined, { midTurn: true }), agent({ state: 'idle' }))).toBe('sending…');
    expect(sentLabel(sent('a', undefined, { status: 'waiting' }), agent({ state: 'starting', queuedUntilUp: 1 }))).toBe('waiting for the session to start');
    // Typed once it was up, behind its first prompt's turn.
    expect(sentLabel(sent('a', undefined, { status: 'waiting' }), agent({ state: 'running' }))).toBe('queued: taken at its next step');
  });

  test('a failure says why; one never delivered once its session ended says why too', () => {
    expect(sentLabel(sent('a', undefined, { status: 'failed', error: 'Ada has ended' }), agent())).toBe('Not sent: Ada has ended');
    const never = agent({ undelivered: [{ what: 'A message', text: 'a', reason: 'its session ended first' }] });
    expect(sentLabel(sent('a', undefined, { status: 'waiting' }), never)).toBe('Not delivered: its session ended first');
  });

  test('one a turn has started and ended since, with no copy, was not seen; while a turn goes on it may still come', () => {
    expect(sentLabel(sent('a', undefined, { turns: 1 }), agent())).toBe('Not seen in the transcript');
    expect(sentLabel(sent('a', undefined, { turns: 1, midTurn: true }), agent({ state: 'running' }))).toBe('queued: taken at its next step');
    expect(sentLabel(sent('a', undefined, { turns: 1, status: 'sending' }), agent())).toBe('sending…');
  });
});

describe('sending from the message box', () => {
  test('shows at once as sending, then as the answer says; a failure keeps it, to retry or drop', async () => {
    let answer!: { resolve(value: { queued: boolean }): void; reject(error: Error): void };
    const send = vi.fn(() => new Promise<{ queued: boolean }>((resolve, reject) => (answer = { resolve, reject })));
    const messages = createSentMessages(send);
    const heard = vi.fn();
    messages.subscribe(heard);
    messages.read('s', { generation: 3, end: 4 });

    const sending = messages.send('s', 'Postgres', [], true);
    expect(messages.get('s')).toEqual([expect.objectContaining({ text: 'Postgres', status: 'sending', midTurn: true, after: { generation: 3, end: 4 } })]);
    expect(heard).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('s', 'Postgres', false);
    answer.resolve({ queued: true });
    await sending;
    expect(messages.get('s')[0]!.status).toBe('waiting');

    const failing = messages.send('s', 'SQLite', ["'/tmp/a.png'"], false);
    expect(send).toHaveBeenLastCalledWith('s', 'SQLite', false);
    answer.reject(new Error('Ada needs permission first'));
    await failing;
    const failed = messages.get('s')[1]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'Ada needs permission first' });

    const retrying = messages.retry('s', failed.id, false);
    expect(messages.get('s')[1]!.status).toBe('sending');
    answer.resolve({ queued: false });
    await retrying;
    expect(messages.get('s')[1]!.status).toBe('sent');

    messages.drop('s', failed.id);
    expect(messages.get('s').map((message) => message.text)).toEqual(['Postgres']);
    expect(messages.get('other')).toEqual([]);
  });

  test('a message with an image in it is pasted', () => {
    const send = vi.fn(() => Promise.resolve({ queued: false }));
    createSentMessages(send).send('s', "Why? '/tmp/a.png'", ["'/tmp/a.png'"], false);
    expect(send).toHaveBeenCalledWith('s', "Why? '/tmp/a.png'", true);
  });

  test("a command (/compact, !ls) goes once it is delivered, as the harness keeps it out of the transcript; one that fails stays", async () => {
    const send = vi.fn(() => Promise.resolve({ queued: false }));
    const messages = createSentMessages(send);
    await messages.send('s', '  /compact', [], false);
    await messages.send('s', '!ls', [], false);
    expect(messages.get('s')).toEqual([]);
    send.mockRejectedValueOnce(new Error('Ada has ended'));
    await messages.send('s', '/model', [], false);
    expect(messages.get('s')).toEqual([expect.objectContaining({ text: '/model', status: 'failed', command: true })]);
  });

  test('a message that starts with a path is a message, not a command', () => {
    const messages = createSentMessages(() => new Promise(() => {}));
    void messages.send('s', '/Users/me/app/src/x.ts throws on load', [], false);
    void messages.send('s', '/compact keep the plan', [], false);
    expect(messages.get('s').map((message) => message.command)).toEqual([false, true]);
  });

  test("each turn the agent starts counts for the messages sent before it, but not the turn one was sent into", () => {
    const messages = createSentMessages(() => new Promise(() => {}));
    void messages.send('s', 'a', [], false);
    messages.turnStarted('s');
    void messages.send('s', 'b', [], true);
    messages.turnStarted('s');
    expect(messages.get('s').map((message) => message.turns)).toEqual([2, 1]);
  });
});
