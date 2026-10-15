import { describe, expect, it } from 'vitest';
import { isLocalUrl, isWebTabRequest, isWebTabUrl, keptWebUrl, localWebLinks, webTabLabel, webTabUrl } from '../src/web-url.ts';

describe('what a web tab may show', () => {
  it.each([
    'https://example.com/',
    'https://docs.example.com:8443/a?b=c#d',
    'http://localhost:5173/',
    'http://localhost/',
    'http://127.0.0.1:3000/app',
    'http://[::1]:8080/',
    'https://localhost:5173/',
  ])('shows %s', (url) => {
    expect(isWebTabUrl(url)).toBe(true);
  });

  it.each([
    ['plain http to another host', 'http://example.com/'],
    ['a host that only looks local', 'http://localhost.example.com/'],
    ['another loopback address', 'http://127.0.0.2/'],
    ['a local file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<p>hi</p>'],
    ['javascript', 'javascript:alert(1)'],
    ['blob', 'blob:https://example.com/x'],
    ['the app', 'agent-board-image://x'],
    ['ftp', 'ftp://example.com/'],
    ['about', 'about:blank'],
    ['a websocket', 'ws://localhost:5173/'],
    ['a name and password', 'https://me:secret@example.com/'],
    ['no URL at all', 'localhost:5173'],
    ['nothing', ''],
  ])('never shows %s', (_, url) => {
    expect(isWebTabUrl(url)).toBe(false);
  });

  it("loads what its pages load from the same places, and their websockets (a dev server's hot reload)", () => {
    expect(isWebTabRequest('https://cdn.example.com/a.js')).toBe(true);
    expect(isWebTabRequest('ws://localhost:5173/')).toBe(true);
    expect(isWebTabRequest('wss://example.com/live')).toBe(true);
    expect(isWebTabRequest('ws://example.com/')).toBe(false);
    expect(isWebTabRequest('http://example.com/a.js')).toBe(false);
    expect(isWebTabRequest('file:///etc/passwd')).toBe(false);
  });
});

describe('a URL typed into a web tab', () => {
  it.each([
    ['localhost:5173', 'http://localhost:5173/'],
    ['  127.0.0.1:3000/app ', 'http://127.0.0.1:3000/app'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['example.com/docs', 'https://example.com/docs'],
    ['http://localhost:5173', 'http://localhost:5173/'],
    ['https://example.com', 'https://example.com/'],
  ])('reads %s as %s', (typed, url) => {
    expect(webTabUrl(typed)).toBe(url);
  });

  it.each(['http://example.com', 'file:///tmp', 'javascript:alert(1)', 'data:text/html,x', '', 'not a url at all'])('refuses %s', (typed) => {
    expect(webTabUrl(typed)).toBeUndefined();
  });
});

describe("a web tab's name", () => {
  it('is its host, with the port for a local server', () => {
    expect(webTabLabel('http://localhost:5173/app')).toBe('localhost:5173');
    expect(webTabLabel('https://docs.example.com/a')).toBe('docs.example.com');
    expect(webTabLabel('not a url')).toBe('not a url');
  });
});

describe('the local web links in a line of output', () => {
  it("finds a dev server's address, where it is in the line", () => {
    const line = '  ➜  Local:   http://localhost:5173/ and http://127.0.0.1:3000/x.';
    expect(localWebLinks(line)).toEqual([
      { url: 'http://localhost:5173/', start: line.indexOf('http://localhost'), end: line.indexOf('http://localhost') + 'http://localhost:5173/'.length },
      { url: 'http://127.0.0.1:3000/x', start: line.indexOf('http://127'), end: line.indexOf('http://127') + 'http://127.0.0.1:3000/x'.length },
    ]);
  });

  it('finds [::1] and https on a local host, and nothing remote', () => {
    expect(localWebLinks('at http://[::1]:8080 now').map((link) => link.url)).toEqual(['http://[::1]:8080/']);
    expect(localWebLinks('https://localhost:8443/').map((link) => link.url)).toEqual(['https://localhost:8443/']);
    expect(localWebLinks('see https://example.com and http://localhost.example.com')).toEqual([]);
  });

  it('leaves off closing punctuation and brackets around it', () => {
    expect(localWebLinks('(http://localhost:5173/)').map((link) => link.url)).toEqual(['http://localhost:5173/']);
    expect(localWebLinks("'http://localhost:3000',").map((link) => link.url)).toEqual(['http://localhost:3000/']);
  });
});

describe('what a web tab keeps of its URL for the next start', () => {
  it('is where its page is, never a query or fragment that may hold a sign-in code or token', () => {
    expect(keptWebUrl('http://localhost:3000/auth/callback?code=secret#access_token=t')).toBe('http://localhost:3000/auth/callback');
    expect(keptWebUrl('https://intranet/docs')).toBe('https://intranet/docs');
    expect(keptWebUrl('file:///etc/passwd')).toBeUndefined();
  });
});

describe('a URL on this machine', () => {
  it('is one on its loopback host, over any scheme', () => {
    expect(['http://localhost:5173/', 'ws://127.0.0.1:24678/', 'https://[::1]/'].every(isLocalUrl)).toBe(true);
    expect(['https://example.com/', 'http://localhost.example.com/', 'not a url'].some(isLocalUrl)).toBe(false);
  });
});
