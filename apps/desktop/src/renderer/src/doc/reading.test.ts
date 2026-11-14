import { describe, expect, it } from 'vitest';
import {
  boldLeads,
  findingsLine,
  findingsOf,
  minutesLeft,
  placeKey,
  placeOf,
  railShown,
  readingOf,
  severityLine,
  spy,
  timeLeft,
  verdictOf,
  wordCount,
} from './reading';
import { REVIEW } from './reading-fixture';

describe('verdictOf', () => {
  it('reads a verdict as a chip and its tone', () => {
    expect(verdictOf('changes-requested')).toEqual({ text: 'changes-requested', label: 'Changes requested', tone: 'waiting' });
    expect(verdictOf('approve')).toMatchObject({ label: 'Approve', tone: 'ok' });
    expect(verdictOf('REJECT')).toMatchObject({ tone: 'failed' });
    expect(verdictOf('hmm')).toMatchObject({ tone: 'neutral' });
  });
  it('reads a verdict by its leading word, so a negation or a rider doesn’t flip it', () => {
    expect(verdictOf('not-blocked')).toMatchObject({ tone: 'neutral' });
    expect(verdictOf('approved-with-changes')).toMatchObject({ tone: 'ok' });
    expect(verdictOf('request-changes')).toMatchObject({ tone: 'waiting' });
    expect(verdictOf('blocked')).toMatchObject({ tone: 'failed' });
  });
});

describe('boldLeads', () => {
  it('sets bold the words before a list item’s first colon', () => {
    expect(boldLeads('1. Must change: the tests.\n- Why? Because.\n- No colon here')).toBe('1. **Must change:** the tests.\n- **Why?** Because.\n- No colon here');
  });
  it('leaves an item already bold alone', () => {
    expect(boldLeads('- **Done:** yes')).toBe('- **Done:** yes');
  });
  it('leaves a code block as written', () => {
    const fenced = '```\n- foo: bar\n```\n- Lead: on';
    expect(boldLeads(fenced)).toBe('```\n- foo: bar\n```\n- **Lead:** on');
  });
});

describe('readingOf', () => {
  it('lifts the review’s verdict and its section for the reader, and drops the title heading', () => {
    const reading = readingOf(REVIEW, 'Review of the interface size change (PR #578), round 1');
    expect(reading.body.startsWith('Reviewed commit')).toBe(true);
    expect(reading.decision?.verdict?.label).toBe('Changes requested');
    expect(reading.decision?.from).toEqual({ id: 'read-for-you-plain-english', title: 'For you (plain English)' });
    expect(reading.decision?.body).toMatch(/^1\. /);
    expect(reading.words).toBeGreaterThan(1500);
    expect(minutesLeft(reading.words, 0)).toBe(Math.ceil(reading.words / 230));
  });

  it('keeps a first heading that is not the title', () => {
    expect(readingOf('# Other\n\nText', 'Title').body).toBe('# Other\n\nText');
  });

  it.each(['TL;DR', 'Summary', 'Decision', 'For the team'])('takes a %s section, up to the next heading of its level', (heading) => {
    const reading = readingOf(`Intro.\n\n## ${heading}\n\n- Ship it: yes\n\n### Inside\n\nStill in.\n\n## Next\n\nOut.`);
    expect(reading.decision?.body).toBe('- **Ship it:** yes\n\n### Inside\n\nStill in.');
    expect(reading.decision?.verdict).toBeUndefined();
  });

  it('never takes a first-level heading’s section, which would be the whole document', () => {
    const reading = readingOf('# Summary of the migration\n\nAll of it.\n\n## Part\n\nMore.');
    expect(reading.decision).toBeUndefined();
  });

  it('takes no "For example" section', () => {
    expect(readingOf('## For example\n\nX\n\n## Summary\n\nY').decision?.body).toBe('Y');
  });

  it('jumps to a Decision section by its own id, not the card’s', () => {
    expect(readingOf('Intro.\n\n## Decision\n\nShip it.').decision?.from?.id).not.toBe('read-decision');
  });

  it('prefers a "For …" section to a summary', () => {
    expect(readingOf('## Summary\n\nA\n\n## For you\n\nB').decision?.body).toBe('B');
  });

  it('shows the verdict alone with no section', () => {
    expect(readingOf('VERDICT: approve\n\nAll good.').decision).toEqual({ verdict: verdictOf('approve') });
  });

  it('has no card with no verdict and no section for the reader: it would only repeat the first paragraph', () => {
    expect(readingOf('# Heading\n\nFirst para.\n\nSecond.').decision).toBeUndefined();
    expect(readingOf('# Only a heading').decision).toBeUndefined();
    expect(readingOf('').decision).toBeUndefined();
  });
});

describe('findings lines', () => {
  const findings = findingsOf(readingOf(REVIEW).outline);
  it('counts the review’s findings by severity', () => {
    expect(findingsLine(findings)).toBe('7 findings: 2 blockers, 1 major, 4 minor');
    expect(severityLine(findings)).toBe('2 blockers · 1 major · 4 minor');
    expect(findingsLine([])).toBe('');
  });
});

describe('time left', () => {
  it('says how long, then how long is left, then that it is read', () => {
    expect(timeLeft(1840, 0)).toBe('8 min read');
    expect(timeLeft(1840, 0.42)).toBe('5 min left');
    expect(timeLeft(1840, 0.99)).toBe('Read to the end');
    expect(minutesLeft(10, 0.5)).toBe(1);
    expect(wordCount("It's a **two-word** test")).toBe(4);
  });
});

describe('spy', () => {
  const marks = [
    { id: 'a', section: 'a', top: 0 },
    { id: 'f1', section: 'a', top: 100 },
    { id: 'f2', section: 'a', top: 200 },
    { id: 'b', section: 'b', top: 400 },
  ];
  it('finds the mark the reader is in and ticks those passed', () => {
    const at = spy(marks, 160, false);
    expect(at).toMatchObject({ current: 'f2', section: 'a' });
    expect([...at.passed]).toEqual(['f1']);
    expect([...spy(marks, 400, false).passed].sort()).toEqual(['a', 'f1', 'f2']);
  });
  it('ticks the current one at the end, and copes with no marks', () => {
    expect(spy(marks, 400, true).passed.has('b')).toBe(true);
    expect(spy([], 0, false).current).toBeUndefined();
  });
});

describe('railShown', () => {
  it('shows the rail when wide, unless told', () => {
    expect(railShown(900, undefined)).toBe(true);
    expect(railShown(700, undefined)).toBe(false);
    expect(railShown(700, true)).toBe(true);
    expect(railShown(900, false)).toBe(false);
  });
});

describe('kept place', () => {
  it('reads back a place, and nothing from junk', () => {
    expect(placeKey('/a/b.md')).toBe('reading-place:/a/b.md');
    expect(placeOf(JSON.stringify({ version: 2, top: 300, open: ['read-finding-1', 3] }))).toEqual({ top: 300, open: ['read-finding-1'] });
    expect(placeOf(null)).toBeUndefined();
    expect(placeOf('{')).toBeUndefined();
    expect(placeOf('{"top":1}')).toBeUndefined();
  });
});
