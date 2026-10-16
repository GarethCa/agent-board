import { describe, expect, it } from 'vitest';
import { agentNoteData, agentNoteFooter, clockTime } from './agent-note';

const at = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes).toISOString();

describe('an agent note', () => {
  it('reads its data, with defaults for anything missing', () => {
    expect(agentNoteData({})).toEqual({
      text: '',
      agent: { sessionId: '', name: 'An agent', harness: 'claude', role: null },
      writtenAt: '',
      editedByUser: false,
    });
    const author = { sessionId: 's1', name: 'Master Orchestrator', harness: 'codex', role: 'orchestrator' };
    expect(agentNoteData({ text: 'hi', agent: author, writtenAt: at(14, 2), editedByUser: true, asked: 'Why?' })).toEqual({
      text: 'hi',
      agent: author,
      writtenAt: at(14, 2),
      editedByUser: true,
      asked: 'Why?',
    });
  });

  it('shows the time on the clock, or nothing for no time', () => {
    expect(clockTime(at(9, 5))).toBe('09:05');
    expect(clockTime('')).toBe('');
  });

  it("says “edited by you” once the user edits it, else when its agent wrote it again, else nothing", () => {
    const written = agentNoteData({ text: 'x', writtenAt: at(14, 2) });
    expect(agentNoteFooter({ ...written, editedByUser: true }, at(14, 2))).toEqual({ kind: 'edited' });
    expect(agentNoteFooter({ ...written, writtenAt: at(14, 31) }, at(14, 2))).toEqual({ kind: 'updated', time: '14:31' });
    expect(agentNoteFooter(written, at(14, 2))).toBeUndefined();
    expect(agentNoteFooter(written, at(14, 30))).toBeUndefined();
    // Made in this window, the daemon hasn't stamped it yet.
    expect(agentNoteFooter(written, '')).toBeUndefined();
  });
});
