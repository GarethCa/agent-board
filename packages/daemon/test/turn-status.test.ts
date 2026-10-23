import { describe, expect, it } from 'vitest';
import { isWorking, statusAfterTurn, summaryOfMessage } from '../src/turn-status.ts';

const own = { summary: 'Map the board', progress: 20, updatedAt: '2026-10-16T10:00:00.000Z', setBy: null };
const at = '2026-10-16T11:00:00.000Z';

describe('summaryOfMessage', () => {
  it('is the summary of a STATUS marker, and nothing else of the message', () => {
    expect(summaryOfMessage('Fixed it.\nSTATUS: done | PR 12 is open')).toBe('PR 12 is open');
    expect(summaryOfMessage('\n  Handover written.\nSTATUS: done')).toBeNull();
    expect(summaryOfMessage('STATUS: blocked')).toBeNull();
    expect(summaryOfMessage('Done. The flake was a race in the retry.')).toBeNull();
    expect(summaryOfMessage('   ')).toBeNull();
    expect(summaryOfMessage(undefined)).toBeNull();
  });

  it('cuts a long summary to a status’s length', () => {
    expect(summaryOfMessage(`STATUS: done | ${'x'.repeat(500)}`)).toHaveLength(200);
  });
});

describe('statusAfterTurn', () => {
  it('keeps what an agent mid-turn set, percentage included', () => {
    expect(statusAfterTurn(own, true, 'Done.', at)).toBe(own);
  });

  it('drops the percentage once the turn has ended or the agent has, keeping its own summary', () => {
    expect(statusAfterTurn(own, false, 'Done.', at)).toEqual({ ...own, progress: null });
  });

  it('shows the marker summary of the last message of an agent that set nothing, else nothing', () => {
    expect(statusAfterTurn(null, false, 'Done.\nMore.', at)).toBeNull();
    expect(statusAfterTurn(null, false, 'Done.\nSTATUS: done | PR open', at)).toEqual({ summary: 'PR open', progress: null, updatedAt: at, setBy: null });
    expect(statusAfterTurn(null, false, undefined, at)).toBeNull();
    expect(statusAfterTurn(null, true, 'Done.', at)).toBeNull();
  });
});

describe('isWorking', () => {
  const live = { endedAt: null, ask: null, plan: null };
  it('is true mid-turn and for a call waiting on the user, false at the prompt or once ended', () => {
    expect(isWorking({ ...live, state: 'running' })).toBe(true);
    expect(isWorking({ ...live, state: 'waiting', ask: {} as never })).toBe(true);
    expect(isWorking({ ...live, state: 'waiting' })).toBe(false);
    expect(isWorking({ ...live, state: 'idle' })).toBe(false);
    expect(isWorking({ endedAt: 'x', ask: null, plan: null, state: 'running' })).toBe(false);
  });
});
