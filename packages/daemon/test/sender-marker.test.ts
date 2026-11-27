import { describe, expect, it } from 'vitest';
import { handoffLine } from '../src/handoff-text.ts';
import { HAND_OFF_HEAD, SEND_TRAILER } from '../src/protocol.ts';
import { BOARD_LEAD, clockName, markClock, markSender, readSender, sendTrailer } from '../src/sender-marker.ts';

describe('markSender', () => {
  it('heads the message with its kind, sender and ref, on its first line', () => {
    expect(markSender('send', 'Captain', 'agent:944e1234', 'Fix the login test')).toBe('⟨send from Captain · agent:944e1234⟩ Fix the login test');
  });

  it('keeps the name printable, on one line, and free of the brackets that end the mark', () => {
    expect(markSender('reply', 'Le⟩ad\n\x1b one', 'agent:1', 'Hi')).toBe('⟨reply from Le ad one · agent:1⟩ Hi');
    expect(markSender('send', '⟨⟩', 'agent:1', 'Hi')).toBe('⟨send from an agent · agent:1⟩ Hi');
  });
});

describe('markClock', () => {
  it("heads a clock's prompt with the clock's name and ref, as an agent's mark does", () => {
    expect(markClock('Master check-in', 'c0ffee12-3456', 'Check the crew')).toBe('⟨clock from Master check-in · item:c0ffee12-3456⟩ Check the crew');
  });

  it("names a clock by its prompt's first line, cut short, and a clock with no words as a clock", () => {
    expect(clockName('Master check-in\n\nRead the board')).toBe('Master check-in');
    expect(clockName('  Look over every open pull request and the queue  ')).toBe('Look over every open pull reque…');
    expect(clockName('⟨⟩')).toBe('a clock');
  });

  it('leaves a prompt that is a command unmarked, so it still runs as one', () => {
    expect(markClock('/compact', 'c0ffee12', '/compact')).toBe('/compact');
    expect(markClock('!make test', 'c0ffee12', '  !make test')).toBe('  !make test');
    expect(markClock('Run /compact', 'c0ffee12', 'Run /compact')).toBe('⟨clock from Run /compact · item:c0ffee12⟩ Run /compact');
  });
});

describe('readSender', () => {
  describe('of the messages no agent sent', () => {
    it("reads a clock's run as the clock's, by its name and ref, not the user's", () => {
      expect(readSender(markClock('Master check-in', 'c0ffee12', 'Check the crew'))).toEqual({
        text: 'Check the crew',
        from: { ref: 'item:c0ffee12', name: 'Master check-in', kind: 'clock' },
      });
    });

    it("reads the board's own notice as the board's, without its lead", () => {
      expect(readSender(`${BOARD_LEAD}The user commented on plan.md (v2):\nLooks good`)).toEqual({
        text: 'The user commented on plan.md (v2):\nLooks good',
        from: { ref: 'board', name: 'agent-board', kind: 'board' },
      });
    });

    it("keeps as the user's a mark whose kind and ref don't match, and a lead anywhere but the start", () => {
      expect(readSender('⟨clock from Check-in · agent:944e1234⟩ Hi').from).toBeUndefined();
      expect(readSender('⟨send from Captain · item:944e1234⟩ Hi').from).toBeUndefined();
      expect(readSender('See [agent-board] From lead').from).toBeUndefined();
    });
  });

  it('tells the user, a clock, an agent send, a hand-off and the board apart', () => {
    const texts = [
      'Fix it',
      markClock('Nightly', 'c1', 'Run the gate'),
      markSender('send', 'Captain', 'agent:944e1234', 'Ship it'),
      markSender('hand-off', 'impl', 'agent:ab12cd34', handoffLine('impl', 'plan.md', 'Step one')),
      `${BOARD_LEAD}A merge into the crew branch waits.`,
    ];
    expect(texts.map((text) => readSender(text).from?.kind ?? 'user')).toEqual(['user', 'clock', 'send', 'hand-off', 'board']);
  });

  describe('of a message Claude folded some of', () => {
    const block = (id: string, text: string) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
    const from = { ref: 'agent:1', name: 'lead', kind: 'send' };
    const head = '⟨send from lead · agent:1⟩ ';

    it('finds the mark in a block that is all of it, or only its start, and leaves no wrapper in the text', () => {
      expect(readSender(block('1', `${head}Fix it\nnow`))).toEqual({ text: 'Fix it\nnow', from });
      expect(readSender(`\n${block('1', `${head}Fix it`)}\nand then push`)).toEqual({ text: 'Fix it\nand then push', from });
    });

    it('leaves no wrapper in the text of a block further on, with the mark typed before it', () => {
      expect(readSender(`${head}Fix it ${block('1', 'all\nof\nthis')} now`)).toEqual({ text: 'Fix it all\nof\nthis now', from });
      expect(readSender(`${head}a$1${block('1', '$2')}`)).toEqual({ text: 'a$1$2', from });
    });

    it('keeps as the user\'s a mark that comes after their own words, even inside a block, and leaves their blocks to fold', () => {
      const quoted = `See ${block('1', `${head}Fix it`)}`;
      expect(readSender(quoted)).toEqual({ text: quoted });
    });
  });

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
