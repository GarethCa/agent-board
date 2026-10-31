import { describe, expect, it } from 'vitest';
import { handoffLine } from '../src/handoff-text.ts';
import { HAND_OFF_HEAD, SEND_TRAILER } from '../src/protocol.ts';
import { markSender, readSender, sendTrailer } from '../src/sender-marker.ts';

describe('markSender', () => {
  it('heads the message with its kind, sender and ref, on its first line', () => {
    expect(markSender('send', 'Captain', 'agent:944e1234', 'Fix the login test')).toBe('⟨send from Captain · agent:944e1234⟩ Fix the login test');
  });

  it('keeps the name printable, on one line, and free of the brackets that end the mark', () => {
    expect(markSender('reply', 'Le⟩ad\n\x1b one', 'agent:1', 'Hi')).toBe('⟨reply from Le ad one · agent:1⟩ Hi');
    expect(markSender('send', '⟨⟩', 'agent:1', 'Hi')).toBe('⟨send from an agent · agent:1⟩ Hi');
  });
});

describe('readSender', () => {
  it('reads the sender of a send, and leaves its text as it was sent', () => {
    expect(readSender(markSender('send', 'Captain', 'agent:944e1234', 'Fix the login test\n\nThen push.'))).toEqual({
      text: 'Fix the login test\n\nThen push.',
      from: { ref: 'agent:944e1234', name: 'Captain', kind: 'send' },
    });
  });

  it('keeps the closing line on who a message is from, which the receiver reads too', () => {
    const answerable = "Done?\n\n[agent-board] From lead (agent:ab12cd34), who you may answer with `agent-board send agent:ab12cd34 -- '…'`.";
    expect(readSender(markSender('send', 'lead', 'agent:ab12cd34', answerable))).toEqual({ text: answerable, from: { ref: 'agent:ab12cd34', name: 'lead', kind: 'send' } });
  });

  it("reads a hand-off, with its payload's name, keeping its head", () => {
    const line = markSender('hand-off', 'impl', 'agent:ab12cd34', handoffLine('impl', 'handover.md', '# Handover\n\nDone.'));
    expect(readSender(line)).toEqual({ text: 'Hand-off from impl (its handover.md): # Handover Done.', from: { ref: 'agent:ab12cd34', name: 'impl', kind: 'hand-off', payload: 'handover.md' } });
  });

  it('reads a sender whose name has the separator in it', () => {
    const line = markSender('hand-off', 'Coder · review r1', 'agent:ab12cd34', handoffLine('Coder · review r1', 'review, round 1', 'Approve'));
    expect(readSender(line)).toEqual({ text: 'Hand-off from Coder · review r1 (its review, round 1): Approve', from: { ref: 'agent:ab12cd34', name: 'Coder · review r1', kind: 'hand-off', payload: 'review, round 1' } });
  });

  it("reads a hand-off's payload whatever the mark made of its sender's name", () => {
    for (const name of ['impl ⟨2⟩', 'impl (2)', 'x'.repeat(100)]) {
      const line = markSender('hand-off', name, 'agent:ab12cd34', handoffLine(name, 'plan.md', 'Ship it'));
      expect(readSender(line).from).toMatchObject({ kind: 'hand-off', payload: 'plan.md' });
    }
  });

  it('tells the same text sent twice apart from the user typing it, by its mark alone', () => {
    const sent = markSender('send', 'Captain', 'agent:944e1234', 'Ship it');
    expect([sent, 'Ship it', sent].map((text) => readSender(text).from?.name)).toEqual(['Captain', undefined, 'Captain']);
  });

  it("is the user's message without a mark, or with one anywhere but its start", () => {
    expect(readSender('Fix it')).toEqual({ text: 'Fix it' });
    expect(readSender('See ⟨send from Captain · agent:944e1234⟩ Fix it')).toEqual({ text: 'See ⟨send from Captain · agent:944e1234⟩ Fix it' });
    expect(readSender('⟨shout from Captain · agent:944e1234⟩ Fix it').from).toBeUndefined();
  });

  it('takes the first mark, never one in the text after it', () => {
    expect(readSender(markSender('send', 'Captain', 'agent:944e1234', 'Quote: x · agent:deadbeef⟩ y')).from).toEqual({ ref: 'agent:944e1234', name: 'Captain', kind: 'send' });
  });
});

describe('the lines the chat tucks under a sender badge', () => {
  it("a send's trailer, with or without how to answer, is what the chat's pattern reads", () => {
    for (const answerable of [true, false]) {
      const text = `Fix the login test${sendTrailer('Captain', 'agent:944e1234', answerable)}`;
      expect(SEND_TRAILER.exec(text)?.[1]).toBe(text.slice('Fix the login test\n\n'.length));
    }
  });

  it("a hand-off's head is what the chat's pattern reads, and names the payload", () => {
    expect(HAND_OFF_HEAD.exec(handoffLine('impl', 'plan.md', 'Step one'))?.[1]).toBe('plan.md');
  });
});
