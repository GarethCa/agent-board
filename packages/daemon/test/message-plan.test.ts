import { describe, expect, it } from 'vitest';
import { MESSAGE_RULES, planMessage, type MessageTarget } from '../src/message-plan.ts';

const live: MessageTarget = { name: 'impl', ended: false, paused: false };
const paused: MessageTarget = { ...live, ended: true, paused: true };
const ended: MessageTarget = { ...live, ended: true };
const ways = Object.keys(MESSAGE_RULES) as (keyof typeof MESSAGE_RULES)[];

describe('the plan for a message', () => {
  it('wakes a paused agent with it, but for what the board itself tells it, which waits as for a busy one', () => {
    for (const way of ways.filter((each) => each !== 'tell')) expect(planMessage(paused, MESSAGE_RULES[way]), way).toEqual({ do: 'wake' });
    expect(planMessage(paused, MESSAGE_RULES.tell)).toEqual({ do: 'refuse', reason: 'it is paused', busy: true });
  });

  it('starts an ended agent again only for a hand-off or a scheduled run, and refuses it otherwise', () => {
    expect(planMessage(ended, MESSAGE_RULES.deliver)).toEqual({ do: 'wake' });
    expect(planMessage(ended, MESSAGE_RULES.scheduled)).toEqual({ do: 'wake' });
    for (const way of ['send', 'answer', 'tell'] as const) {
      expect(planMessage(ended, MESSAGE_RULES[way]), way).toEqual({ do: 'refuse', reason: 'impl has ended', busy: false });
    }
  });

  it('types it now at an agent with nothing in its way', () => {
    for (const way of ways) expect(planMessage(live, MESSAGE_RULES[way]), way).toEqual({ do: 'now' });
  });

  it('refuses it while only the user can clear what is in its way, before anything else', () => {
    const asking = { ...live, blocked: 'impl needs permission first', notUp: 'its session is not up', busy: 'it is working' };
    for (const way of ways) expect(planMessage(asking, MESSAGE_RULES[way]), way).toEqual({ do: 'refuse', reason: 'impl needs permission first', busy: true });
  });

  it('keeps it until a session not up yet is, or refuses it as busy for a hand-off or a notice', () => {
    const starting = { ...live, notUp: 'its session is not up yet', busy: 'it is working' };
    for (const way of ['send', 'answer', 'scheduled'] as const) expect(planMessage(starting, MESSAGE_RULES[way]), way).toEqual({ do: 'until-up' });
    for (const way of ['deliver', 'tell'] as const) {
      expect(planMessage(starting, MESSAGE_RULES[way]), way).toEqual({ do: 'refuse', reason: 'its session is not up yet', busy: true });
    }
  });

  it("keeps a send until a busy agent's turn ends, types an answer for its harness to queue, and refuses the rest as busy", () => {
    const working = { ...live, busy: 'it is working' };
    expect(planMessage(working, MESSAGE_RULES.send)).toEqual({ do: 'after-turn' });
    expect(planMessage(working, MESSAGE_RULES.answer)).toEqual({ do: 'now' });
    for (const way of ['deliver', 'tell', 'scheduled'] as const) {
      expect(planMessage(working, MESSAGE_RULES[way]), way).toEqual({ do: 'refuse', reason: 'it is working', busy: true });
    }
  });
});
