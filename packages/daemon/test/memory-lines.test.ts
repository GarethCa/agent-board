import { describe, expect, it } from 'vitest';
import { entryFrom, jobParts, jobsFrom, jobTextOf } from '../src/memory-lines.ts';

describe('an entry as typed', () => {
  it('reads "key: value" with a one-word key, and anything else as a note', () => {
    expect(entryFrom('db-host: pg.internal')).toEqual({ key: 'db-host', text: 'pg.internal' });
    expect(entryFrom('deploy.url:  https://x.test\nsecond line')).toEqual({ key: 'deploy.url', text: 'https://x.test\nsecond line' });
    expect(entryFrom('The cache is cold on Mondays')).toEqual({ key: null, text: 'The cache is cold on Mondays' });
    expect(entryFrom('ship day: Friday')).toEqual({ key: null, text: 'ship day: Friday' });
    expect(entryFrom('https://x.test/path')).toEqual({ key: null, text: 'https://x.test/path' });
  });

  it('takes a key given, or keeps the text whole as a note', () => {
    expect(entryFrom('Friday', { key: ' ship day ' })).toEqual({ key: 'ship day', text: 'Friday' });
    expect(entryFrom('Note: keep it', { note: true })).toEqual({ key: null, text: 'Note: keep it' });
  });
});

describe('a queue’s lines as typed', () => {
  it('reads a job a line, its bullet or box dropped and " -> link" its link', () => {
    expect(jobsFrom('- Fix the login -> https://x.test/1\n\n2. Write docs\n- [ ] Tag it\n* a -> b -> c')).toEqual([
      { text: 'Fix the login', link: 'https://x.test/1' },
      { text: 'Write docs', link: null },
      { text: 'Tag it', link: null },
      { text: 'a -> b', link: 'c' },
    ]);
  });

  it('keeps an arrow in a job’s own words', () => {
    expect(jobsFrom('Rename foo -> bar in the API\nShip it -> https://x.test/2 ')).toEqual([
      { text: 'Rename foo -> bar in the API', link: null },
      { text: 'Ship it', link: 'https://x.test/2' },
    ]);
  });
});

describe('a job’s headline and body', () => {
  it('are its first line and the rest, a blank line between them', () => {
    expect(jobParts('Fix the login')).toEqual({ headline: 'Fix the login', body: '' });
    expect(jobParts('Fix the login\n\nThe token expires.\nSee the logs.\n')).toEqual({ headline: 'Fix the login', body: 'The token expires.\nSee the logs.' });
    expect(jobTextOf('Fix the login', 'The token expires.')).toBe('Fix the login\n\nThe token expires.');
    expect(jobTextOf(' Fix the login ', '  ')).toBe('Fix the login');
    expect(jobParts(jobTextOf('Fix the login', 'One\n\nTwo'))).toEqual({ headline: 'Fix the login', body: 'One\n\nTwo' });
  });

  it('cuts a first line too long for a headline, and keeps the whole text as the body', () => {
    const long = `${'word '.repeat(20)}end`;
    const { headline, body } = jobParts(long);
    expect(headline).toHaveLength(80);
    expect(headline.endsWith('…')).toBe(true);
    expect(body).toBe(long);
  });
});
