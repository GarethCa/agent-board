import { describe, expect, it } from 'vitest';
import { agentNoteData, agentNoteFooter, clockTime, lineBudget, noteStamp, noteStampFull } from './agent-note';

const at = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes).toISOString();

describe('an agent note', () => {
  it('reads its data, with defaults for anything missing', () => {
    expect(agentNoteData({})).toEqual({
      text: '',
      agent: { sessionId: '', name: '', harness: 'claude', role: null },
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

  it('keeps a line budget its agent gave it, until the user sizes it', () => {
    expect(agentNoteData({ text: 'x', lines: 4 }).lines).toBe(4);
    expect(lineBudget({ lines: 4 })).toBe(4);
    expect(lineBudget({ lines: 4, userSized: true })).toBeUndefined();
    for (const lines of [0, -1, 2.5, 41, '4', null, undefined]) {
      expect(lineBudget({ lines })).toBeUndefined();
      expect(agentNoteData({ lines })).not.toHaveProperty('lines');
    }
  });

  it('shows the time on the clock, or nothing for no time', () => {
    expect(clockTime(at(9, 5))).toBe('09:05');
    expect(clockTime('')).toBe('');
  });

  it("says “edited by you” once the user edits it, else when its agent wrote it again, else nothing", () => {
    const written = agentNoteData({ text: 'x', writtenAt: at(14, 2) });
    expect(agentNoteFooter({ ...written, editedByUser: true }, at(14, 2))).toEqual({ kind: 'edited' });
    expect(agentNoteFooter({ ...written, writtenAt: at(14, 31) }, at(14, 2))).toEqual({ kind: 'updated' });
    expect(agentNoteFooter(written, at(14, 2))).toBeUndefined();
    expect(agentNoteFooter(written, at(14, 30))).toBeUndefined();
    // Made in this window, the daemon hasn't stamped it yet.
    expect(agentNoteFooter(written, '')).toBeUndefined();
  });

  // Saturday 31 October 2026, 07:51 on the machine's clock.
  const now = new Date(2026, 9, 31, 7, 51);
  const stamps: [string, Date, string][] = [
    ['earlier today', new Date(2026, 9, 31, 0, 0), 'Today 00:00'],
    ['just now', new Date(2026, 9, 31, 7, 51), 'Today 07:51'],
    ['a minute ahead of the clock', new Date(2026, 9, 31, 7, 52), 'Today 07:52'],
    ['just before midnight', new Date(2026, 9, 30, 23, 59), 'Yesterday 23:59'],
    ['yesterday', new Date(2026, 9, 30, 7, 51), 'Yesterday 07:51'],
    ['two days ago', new Date(2026, 9, 29, 7, 51), 'Thu 07:51'],
    ['six days ago', new Date(2026, 9, 25, 23, 0), 'Sun 23:00'],
    ['seven days ago', new Date(2026, 9, 24, 7, 51), '24 Oct 07:51'],
    ['a month ago', new Date(2026, 8, 3, 7, 51), '3 Sept 07:51'],
    ['a day ahead of the clock', new Date(2026, 10, 1, 7, 51), '1 Nov 07:51'],
    ['last year', new Date(2025, 11, 31, 22, 5), '31 Dec 2025 22:05'],
  ];
  it.each(stamps)('stamps a note from %s with its day and time', (_when, written, expected) => {
    expect(noteStamp(written.toISOString(), now, 'en-GB')).toBe(expected);
  });

  it('counts a day from midnight, across the new year', () => {
    const newYear = new Date(2027, 0, 1, 0, 5);
    expect(noteStamp(new Date(2026, 11, 31, 23, 55).toISOString(), newYear, 'en-GB')).toBe('Yesterday 23:55');
    expect(noteStamp(new Date(2026, 11, 28, 9, 0).toISOString(), newYear, 'en-GB')).toBe('Mon 09:00');
    expect(noteStamp(new Date(2026, 11, 25, 9, 0).toISOString(), newYear, 'en-GB')).toBe('25 Dec 2026 09:00');
  });

  it('keeps the same stamp across a clock change', () => {
    // Late March is when UK clocks go forward: the days either side are still one day apart.
    expect(noteStamp(new Date(2026, 2, 28, 12, 0).toISOString(), new Date(2026, 2, 29, 12, 0), 'en-GB')).toBe('Yesterday 12:00');
  });

  it('stamps in the locale it is given', () => {
    expect(noteStamp(new Date(2026, 9, 3, 7, 51).toISOString(), now, 'en-US')).toBe('Oct 3 07:51');
  });

  it('says nothing for no time, and the date in full for the hover', () => {
    expect(noteStamp('', now)).toBe('');
    expect(noteStamp('not a time', now)).toBe('');
    expect(noteStampFull('')).toBe('');
    // Whether the locale puts a comma after the weekday is the ICU data's to say.
    expect(noteStampFull(new Date(2026, 9, 31, 7, 51).toISOString(), 'en-GB')).toMatch(/^Saturday,? 31 October 2026, 07:51$/);
  });
});
