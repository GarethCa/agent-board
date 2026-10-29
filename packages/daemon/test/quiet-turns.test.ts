import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPINNER_LINE, drawPromptBox } from '@agent-board/fake-harness';
import { createQuietTurns, QUIET_TURN_MS, readTranscriptTail, showsIdlePrompt, turnEndedInTranscript } from '../src/quiet-turns.ts';
import { createFakeClock } from './fake-clock.ts';

/** `lines` as the daemon reads them off a terminal (`screenLines`): box drawing taken out. */
const shown = (lines: string[]) => lines.map((line) => line.replace(/[─-╿]/g, ' ').replace(/\s+/g, ' ').trim());

describe("Claude's prompt between turns, on its screen", () => {
  it('is its prompt box, drawn under what the turn printed', () => {
    expect(showsIdlePrompt(shown(['All tests pass.', '', ...drawPromptBox()]))).toBe(true);
  });

  it("is not its prompt box under a turn's spinner, whose line says Esc interrupts it", () => {
    expect(showsIdlePrompt(shown(['✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)', '', ...drawPromptBox()]))).toBe(false);
  });

  // Claude 2.1.312 draws its turn's footer hint from the interrupt key's binding, truncates that row when narrow and
  // replaces it in team mode; its spinner line has a glyph of `·✢✳✶✻✽` (`*` on some terminals), still under reduced motion.
  it.each([
    ['its spinner line, the footer cut off', SPINNER_LINE],
    ['its spinner line on a terminal drawing `*`', '* Running… (40s)'],
    ['a footer whose interrupt key was rebound', 'ctrl+c to interrupt'],
    ['the footer in team mode', 'esc to return to team lead'],
  ])('is not its prompt box under %s', (_, line) => {
    expect(showsIdlePrompt(shown([line, '', ...drawPromptBox()]))).toBe(false);
  });

  it('is not a menu, or a screen with no prompt on it', () => {
    expect(showsIdlePrompt(['Do you want to proceed?', '❯ 1. Yes', '  2. No'])).toBe(false);
    expect(showsIdlePrompt(['Running npm test…'])).toBe(false);
  });
});

describe('quiet turns', () => {
  const setup = () => {
    const clock = createFakeClock(new Date());
    const checked: string[] = [];
    const quiet = createQuietTurns({ clock, check: (sessionId) => checked.push(sessionId) });
    return { clock, checked, quiet };
  };

  it("checks an agent whose turn has had no hook and no output for the quiet spell, and only then", () => {
    const { clock, checked, quiet } = setup();
    quiet.working('a');
    clock.advance(QUIET_TURN_MS - 1);
    expect(checked).toEqual([]);
    clock.advance(1);
    expect(checked).toEqual(['a']);
  });

  it('starts the spell again on each sign of work, hook or output', () => {
    const { clock, checked, quiet } = setup();
    quiet.working('a');
    clock.advance(QUIET_TURN_MS - 1_000);
    quiet.activity('a');
    clock.advance(QUIET_TURN_MS - 1_000);
    quiet.working('a');
    clock.advance(QUIET_TURN_MS - 1);
    expect(checked).toEqual([]);
    clock.advance(1);
    expect(checked).toEqual(['a']);
  });

  it('checks again a spell later while the agent stays quiet, and never once it stopped working', () => {
    const { clock, checked, quiet } = setup();
    quiet.working('a');
    quiet.working('b');
    clock.advance(QUIET_TURN_MS);
    quiet.stopped('b');
    clock.advance(QUIET_TURN_MS);
    expect(checked).toEqual(['a', 'b', 'a']);
    quiet.stopped('a');
    clock.advance(QUIET_TURN_MS * 3);
    expect(checked).toEqual(['a', 'b', 'a']);
    expect(clock.pending()).toBe(0);
  });

  it('counts each sign of work, so a check that waited on its screen knows of one, however soon it came', () => {
    const clock = createFakeClock(new Date());
    const seen: (number | undefined)[] = [];
    const quiet = createQuietTurns({
      clock,
      check(sessionId) {
        const before = quiet.generation(sessionId);
        // Output in the same instant the check began: as its screen is read.
        quiet.activity(sessionId);
        seen.push(before, quiet.generation(sessionId));
      },
    });
    quiet.working('a');
    clock.advance(QUIET_TURN_MS);
    expect(seen[0]).not.toBe(seen[1]);
    quiet.stopped('a');
    expect(quiet.generation('a')).toBeUndefined();
  });

  it('takes output from an agent not at work as no sign of anything', () => {
    const { clock, checked, quiet } = setup();
    quiet.activity('a');
    clock.advance(QUIET_TURN_MS * 2);
    expect(checked).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

/** A Claude transcript's lines, one JSON entry each, as Claude 2.1.x writes them. */
const entry = (type: 'user' | 'assistant', content: unknown, { id, ...fields }: { id?: string } & Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content, ...(id === undefined ? {} : { id }) }, ...fields });
const prompt = entry('user', 'Tidy the docs');
const call = (id = 'msg_1') => entry('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }], { id });
const result = entry('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12 passed' }]);
const reply = (id = 'msg_2') => entry('assistant', [{ type: 'text', text: 'All tests pass.' }], { id });
const turnEnd = [JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }), JSON.stringify({ type: 'system', subtype: 'turn_duration' })];

describe("a turn's end, in Claude's transcript", () => {
  it('is a reply with no tool call after the last prompt or tool result', () => {
    expect(turnEndedInTranscript([prompt, call(), result, reply(), ...turnEnd])).toBe(true);
    expect(turnEndedInTranscript([prompt, reply(), JSON.stringify({ type: 'attachment' }), JSON.stringify({ type: 'pr-link' })])).toBe(true);
  });

  it('is not a tool call with no result yet: a silent command holds the turn, whatever the screen shows', () => {
    expect(turnEndedInTranscript([prompt, call()])).toBe(false);
    expect(turnEndedInTranscript([prompt, call(), JSON.stringify({ type: 'attachment' })])).toBe(false);
  });

  it('is not a prompt or a tool result with no reply yet: the turn waits on the model', () => {
    expect(turnEndedInTranscript([prompt])).toBe(false);
    expect(turnEndedInTranscript([prompt, call(), result])).toBe(false);
  });

  it("is not a reply whose message, split over several lines, also made a tool call", () => {
    expect(turnEndedInTranscript([prompt, call('msg_1'), reply('msg_1')])).toBe(false);
  });

  it("passes over a compaction's summary and a subagent's lines, which are no turn of its own", () => {
    const compacted = [JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), entry('user', 'This session is being continued…', { isCompactSummary: true })];
    expect(turnEndedInTranscript([prompt, reply(), ...turnEnd, ...compacted])).toBe(true);
    expect(turnEndedInTranscript([prompt, reply(), entry('user', 'Explore the repo', { isSidechain: true })])).toBe(true);
    expect(turnEndedInTranscript([prompt, reply(), entry('user', '<command-name>/model</command-name>', { isMeta: true })])).toBe(true);
  });

  it('says nothing when no line is of the conversation', () => {
    expect(turnEndedInTranscript([])).toBeUndefined();
    expect(turnEndedInTranscript([...turnEnd, '{not json'])).toBeUndefined();
  });

  it("is read from the transcript's last lines, the first of them cut through left out", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'quiet-turns-')), 'session.jsonl');
    writeFileSync(path, [prompt, call(), result, reply()].join('\n') + '\n');
    expect(await readTranscriptTail(path, reply().length + 5)).toEqual([reply()]);
    expect(await readTranscriptTail(path)).toEqual([prompt, call(), result, reply()]);
    expect(await readTranscriptTail(join(path, '..', 'missing.jsonl'))).toEqual([]);
  });
});
