import { describe, expect, it } from 'vitest';
import { jobParts, jobsFrom, jobTextOf } from '../src/queue-lines.ts';

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
