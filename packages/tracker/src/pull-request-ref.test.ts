import { describe, expect, it } from 'vitest';
import { pullRequestOfUrl, pullRequestUrl } from './pull-request-ref.ts';

describe('pullRequestUrl', () => {
  it('is the plain GitHub URL, which reads back as the same pull request', () => {
    const ref = { repo: 'acme/app', number: 41 };
    expect(pullRequestUrl(ref)).toBe('https://github.com/acme/app/pull/41');
    expect(pullRequestOfUrl(pullRequestUrl(ref))).toEqual(ref);
  });
});
