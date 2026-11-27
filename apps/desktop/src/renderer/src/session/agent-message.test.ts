import { describe, expect, test } from 'vitest';
import type { ChatEntry, MessageSender } from '@agent-board/daemon/protocol';
import { agentMessageParts, CLAMP_LINES, foldAgentMessages, fromNoAgent, isLong, messageKindLabel, senderHead } from './agent-message';
import { chatItems, type ChatItem } from './chat';

const captain: MessageSender = { ref: 'agent:944e1234', name: 'Captain', kind: 'send' };

describe('an agent message split into what it says and what the receiver is told', () => {
  test("a send's closing From line is the aside, and the body is what the sender wrote", () => {
    const text = "Fix the login test\n\n[agent-board] From Captain (agent:944e1234), who you may answer with `agent-board send agent:944e1234 -- '…'`.";
    expect(agentMessageParts(text, captain)).toEqual({
      body: 'Fix the login test',
      aside: "[agent-board] From Captain (agent:944e1234), who you may answer with `agent-board send agent:944e1234 -- '…'`.",
    });
  });

  test('the Captain-bound From line, with nothing to answer, is the aside too', () => {
    expect(agentMessageParts('Done.\n\n[agent-board] From impl (agent:1234abcd).', captain)).toEqual({ body: 'Done.', aside: '[agent-board] From impl (agent:1234abcd).' });
  });

  test("a hand-off's head is the aside and its payload is the body", () => {
    const from: MessageSender = { ref: 'agent:1', name: 'impl', kind: 'hand-off', payload: 'plan.md' };
    expect(agentMessageParts('Hand-off from impl (its plan.md): Step one, step two', from)).toEqual({
      body: 'Step one, step two',
      aside: 'Hand-off from impl (its plan.md)',
    });
  });

  test('a message with nothing to tuck away has no aside', () => {
    expect(agentMessageParts('Just this', captain)).toEqual({ body: 'Just this' });
  });

  test("a From line in the middle of a message is the sender's own text", () => {
    const text = 'Quoting:\n[agent-board] From x (agent:1).\nand more';
    expect(agentMessageParts(text, captain)).toEqual({ body: text });
  });
});

describe('when a message is long', () => {
  test('it is past the clamp when it has more lines than that', () => {
    expect(isLong('a\nb\nc\nd')).toBe(false);
    expect(isLong('a\nb\nc\nd\ne')).toBe(true);
    expect(CLAMP_LINES).toBe(4);
  });

  test('or when one line is long enough to wrap past it', () => {
    expect(isLong('x'.repeat(40))).toBe(false);
    expect(isLong('word '.repeat(80))).toBe(true);
  });
});

describe('the kind a message came as', () => {
  test('is named for the person, with a hand-off naming its payload', () => {
    expect(messageKindLabel(captain)).toBe('Message');
    expect(messageKindLabel({ ...captain, kind: 'reply' })).toBe('Reply');
    expect(messageKindLabel({ ...captain, kind: 'hand-off' })).toBe('Hand-off');
    expect(messageKindLabel({ ...captain, kind: 'hand-off', payload: 'plan.md' })).toBe('Hand-off · plan.md');
    expect(messageKindLabel({ ref: 'item:c0ffee12', name: 'Check-in', kind: 'clock' })).toBe('Scheduled run');
    expect(messageKindLabel({ ref: 'board', name: 'agent-board', kind: 'board' })).toBe('Notice');
  });
});

describe('agent messages in a chat the user filtered', () => {
  const entries: ChatEntry[] = [
    { kind: 'user', text: 'Mine' },
    { kind: 'user', text: 'One', from: captain },
    { kind: 'user', text: 'Two', from: captain },
    { kind: 'assistant', text: 'Reply' },
    { kind: 'user', text: 'Three', from: captain },
  ];
  const items = chatItems(entries);

  test('chat items carry who a message is from, and the user keeps no from', () => {
    expect(items.filter((item) => item.kind === 'user').map((item) => ('from' in item ? item.from?.name : 'none'))).toEqual(['none', 'Captain', 'Captain', 'Captain']);
  });

  test('with agents included, nothing changes', () => {
    expect(foldAgentMessages(items, true)).toBe(items);
  });

  test('without them, a run of agent messages is one line saying how many', () => {
    const folded: ChatItem[] = foldAgentMessages(items, false);
    expect(folded.map((item) => item.kind)).toEqual(['user', 'agents-hidden', 'assistant', 'agents-hidden']);
    expect(folded.filter((item) => item.kind === 'agents-hidden').map((item) => item.count)).toEqual([2, 1]);
    expect(folded.some((item) => item.kind === 'agents-hidden' && item.notAgents)).toBe(false);
  });

  test("a run with a clock's run or the board's notice in it says so, as not only agents'", () => {
    const folded = foldAgentMessages(
      chatItems([
        { kind: 'user', text: 'Mine' },
        { kind: 'user', text: 'Fix it', from: captain },
        { kind: 'user', text: 'Check the crew', from: { ref: 'item:c0ffee12', name: 'Check-in', kind: 'clock' } },
      ]),
      false,
    );
    expect(folded.filter((item) => item.kind === 'agents-hidden')).toMatchObject([{ count: 2, notAgents: true }]);
  });
});

describe('who a message is from, as its bubble heads it', () => {
  const clock: MessageSender = { ref: 'item:c0ffee12', name: 'Master check-in', kind: 'clock' };
  const board: MessageSender = { ref: 'board', name: 'agent-board', kind: 'board' };
  const agent: MessageSender = { ref: 'agent:944e1234', name: 'Captain', kind: 'send' };

  test('names an agent "From …", a clock by its name, and the board by its own', () => {
    expect(senderHead(agent)).toBe('From Captain');
    expect(senderHead(clock)).toBe('Clock · Master check-in');
    expect(senderHead(board)).toBe('agent-board');
  });

  test('counts a clock and the board as no agent, and every agent kind as one', () => {
    expect([agent, { ...agent, kind: 'reply' as const }, { ...agent, kind: 'hand-off' as const }, clock, board].map(fromNoAgent)).toEqual([false, false, false, true, true]);
  });
});
