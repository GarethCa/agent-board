import { describe, expect, it } from 'vitest';
import { isWebUrl } from './web-link.ts';

describe('isWebUrl', () => {
  it.each(['https://example.com', 'https://example.com/a?b=c#d', 'HTTPS://Example.com/', 'Https://github.com/acme/app/pull/7'])('takes %s', (url) => {
    expect(isWebUrl(url)).toBe(true);
  });

  it.each(['http://example.com/', 'https:example.com', 'https://', 'https://exa mple.com/', 'https://example.com/a b', ' https://example.com/', 'file:///etc/hosts', 'javascript:alert(1)', 'mailto:a@b.c', '', 'example.com'])(
    'refuses %j',
    (url) => {
      expect(isWebUrl(url)).toBe(false);
    },
  );
});
