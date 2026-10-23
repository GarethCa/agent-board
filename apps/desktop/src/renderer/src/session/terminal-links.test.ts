import { describe, expect, test } from 'vitest';
import { MAX_LINK_CHARS, bufferLinks, hyperlinkAddress, hyperlinkHint, linkHint, linkTarget, textLinks, type BufferRow } from './terminal-links';

const urls = (text: string) => textLinks(text).map(({ url }) => url);

/**
 * Rows as the terminal holds them, padded to `cols`: a line starting `~` is soft-wrapped onto the one above, and a
 * wide glyph (`好`) leaves the cell after it empty.
 */
function buffer(cols: number, ...lines: string[]) {
  const rows: BufferRow[] = lines.map((line) => {
    const wrapped = line.startsWith('~');
    const cells: (string | undefined)[] = [];
    for (const char of wrapped ? line.slice(1) : line) {
      cells.push(char);
      if (char === '好') cells.push(undefined);
    }
    while (cells.length < cols) cells.push('');
    return { cells, wrapped };
  });
  return (y: number) => rows[y - 1];
}
const at = (rows: ReturnType<typeof buffer>, y: number, cols: number) => bufferLinks(rows, y, cols).map(({ url, start, end }) => [url, start, end]);
const only = (rows: ReturnType<typeof buffer>, y: number, cols: number) => bufferLinks(rows, y, cols).map(({ url }) => url);

describe('addresses in text', () => {
  test('an https address, and one on this machine', () => {
    expect(textLinks('see https://example.com/docs?a=1 now')).toEqual([{ url: 'https://example.com/docs?a=1', start: 4, end: 32 }]);
    expect(urls('Local: http://localhost:5173/ https://localhost:8443/x')).toEqual(['http://localhost:5173/', 'https://localhost:8443/x']);
  });

  test('other schemes, other hosts over http and addresses with a password are never links', () => {
    expect(urls('file:///etc/passwd javascript:alert(1) http://example.com ftp://example.com https://user:pw@example.com/')).toEqual([]);
  });

  test("a sentence's punctuation and an unbalanced bracket are not the address", () => {
    expect(urls('Open https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(urls('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  test('several come in order', () => {
    expect(urls('https://a.example http://127.0.0.1:3000 https://b.example')).toEqual(['https://a.example/', 'http://127.0.0.1:3000/', 'https://b.example/']);
  });
});

describe('where a click goes', () => {
  test('a web tab by default, the browser with Shift', () => {
    expect(linkTarget('https://example.com/', false, true)).toBe('web-tab');
    expect(linkTarget('http://localhost:5173/', false, true)).toBe('web-tab');
    expect(linkTarget('https://example.com/', true, true)).toBe('browser');
  });

  test('the browser is never sent a local http address', () => {
    expect(linkTarget('http://localhost:5173/', true, true)).toBeUndefined();
    expect(linkTarget('http://localhost:5173/', false, false)).toBeUndefined();
  });

  test('a window without tabs sends https to the browser', () => {
    expect(linkTarget('https://example.com/', false, false)).toBe('browser');
  });

  test('the hover says what each click does', () => {
    const keys = { open: '⌘ click', browser: '⇧⌘ click' };
    expect(linkHint('https://example.com/', true, keys)).toBe('⌘ click to open in a web tab, ⇧⌘ click for the browser');
    expect(linkHint('http://localhost:1/', true, keys)).toBe('⌘ click to open in a web tab');
    expect(linkHint('https://example.com/', false, keys)).toBe('⌘ click to open in the browser');
  });
});

describe('addresses wrapped over terminal rows', () => {
  test('one the terminal soft-wrapped is a single link, found from either row', () => {
    const rows = buffer(20, 'go to https://exampl', '~e.com/a/b/c and on');
    const link = ['https://example.com/a/b/c', { x: 7, y: 1 }, { x: 11, y: 2 }];
    expect(at(rows, 1, 20)).toEqual([link]);
    expect(at(rows, 2, 20)).toEqual([link]);
  });

  test('one wrapped over three rows is one link', () => {
    const rows = buffer(10, 'see https:', '~//example.', '~com/x end');
    expect(only(rows, 3, 10)).toEqual(['https://example.com/x']);
    expect(at(rows, 3, 10)).toEqual([['https://example.com/x', { x: 5, y: 1 }, { x: 5, y: 3 }]]);
  });

  test('a glyph that fills two cells does not shift the link', () => {
    const rows = buffer(40, '好好 https://example.com/x');
    expect(at(rows, 1, 40)).toEqual([['https://example.com/x', { x: 6, y: 1 }, { x: 26, y: 1 }]]);
  });

  test('a row between short ones keeps its own address', () => {
    const rows = buffer(40, 'one', 'https://example.com/a', 'three');
    expect(at(rows, 2, 40)).toEqual([['https://example.com/a', { x: 1, y: 2 }, { x: 21, y: 2 }]]);
    expect(at(rows, 1, 40)).toEqual([]);
  });

  // A full-screen UI ends each of its rows itself, so a row that fills the width is not a wrap, whatever follows it.
  describe('a row that merely fills the width joins nothing', () => {
    const cols = 24;
    const edge = 'https://github.com/o/pr1'; // exactly 24 wide
    const cases: [string, string][] = [
      ['prose after it', '  and merged it.'],
      ['a box border', '╭────────────────╮'],
      ['a separator, then text', '────────────────────'],
      ['a list item', '- next item'],
      ['a path', '/Users/me/My Documents'],
      ['the shell prompt', '❯'],
      ['a Vite line', '➜  Network: use --host'],
    ];
    test.each(cases)('%s', (_name, next) => {
      const rows = buffer(cols, edge, next);
      expect(only(rows, 1, cols)).toEqual([edge]);
      expect(only(rows, 2, cols)).toEqual([]);
    });

    test('the Vite Local line at the edge stays a clean localhost link', () => {
      const local = '  ➜  Local: http://localhost:5173/';
      const rows = buffer(local.length, local, '  ➜  Network: use --host to expose');
      expect(only(rows, 1, local.length)).toEqual(['http://localhost:5173/']);
    });
  });

  test('a very long chain of wrapped rows does not overflow the stack or take long', () => {
    const rows = buffer(10, 'https://example.com/aaa', ...Array.from({ length: 10_000 }, () => '~' + 'a'.repeat(10)));
    for (const y of [1, 2, 5_000, 10_001]) expect(() => bufferLinks(rows, y, 10)).not.toThrow();
  });

  describe('an address longer than the limit is no link, on any of its rows, and nor is one nested in it', () => {
    const cols = 10;
    const rest = 'a'.repeat(MAX_LINK_CHARS + 500);
    const rowsOf = (head: string) => {
      const text = head + rest;
      return buffer(cols, ...Array.from({ length: Math.ceil(text.length / cols) }, (_, i) => (i === 0 ? '' : '~') + text.slice(i * cols, (i + 1) * cols)));
    };
    test.each([
      ['a plain address', 'https://example.com/'],
      ['one carrying another address', 'https://good.example/login?next=https://evil.example/p'],
    ])('%s', (_name, head) => {
      const rows = rowsOf(head);
      const last = Math.ceil((head.length + rest.length) / cols);
      for (const y of [1, 2, 100, Math.floor(last / 2), last - 1, last]) expect(only(rows, y, cols)).toEqual([]);
    });

    test('one that fits is whole from every row', () => {
      const text = 'https://good.example/login?next=https://evil.example/p' + 'a'.repeat(400);
      const rows = buffer(cols, ...Array.from({ length: Math.ceil(text.length / cols) }, (_, i) => (i === 0 ? '' : '~') + text.slice(i * cols, (i + 1) * cols)));
      const expected = new URL(text).href;
      for (const y of [1, 2, 20, 45]) expect(only(rows, y, cols)).toEqual([expected]);
    });
  });

});

describe('an OSC 8 hyperlink target', () => {
  test('an https address, and one on this machine, is the address', () => {
    expect(hyperlinkAddress('https://github.com/o/r/pull/12')).toBe('https://github.com/o/r/pull/12');
    expect(hyperlinkAddress('http://localhost:5173/a')).toBe('http://localhost:5173/a');
  });

  test("it is an exact URI, not prose: punctuation, brackets, quotes and a capital scheme are all the address's own", () => {
    expect(hyperlinkAddress('https://example.com/a.')).toBe('https://example.com/a.');
    expect(hyperlinkAddress('https://example.com/a)')).toBe('https://example.com/a)');
    expect(hyperlinkAddress('https://example.com/a:')).toBe('https://example.com/a:');
    expect(hyperlinkAddress('https://example.com/search?filter[status]=open')).toBe('https://example.com/search?filter[status]=open');
    expect(hyperlinkAddress('https://example.com/{id}')).toBe('https://example.com/%7Bid%7D');
    expect(hyperlinkAddress("https://en.wikipedia.org/wiki/Hitchhiker's_Guide")).toBe("https://en.wikipedia.org/wiki/Hitchhiker's_Guide");
    expect(hyperlinkAddress('HTTPS://EXAMPLE.COM/A')).toBe('https://example.com/A');
  });

  test('other schemes, other hosts over http, passwords, whitespace and no address at all are never links', () => {
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com/', 'https://user:pw@example.com/', 'see https://example.com/', 'https://example.com/ https://other.example/', 'https://example.com/a\tb', 'https://example.com/\u0007', 'not a url', '']) {
      expect(hyperlinkAddress(target)).toBeUndefined();
    }
  });
});

describe('what hovering an OSC 8 hyperlink says', () => {
  const keys = { open: '⌘-click', browser: '⌘⇧-click' };

  test('where it goes, then what a click does', () => {
    expect(hyperlinkHint('https://github.com/o/r/pull/12', true, keys)).toBe('https://github.com/o/r/pull/12 — ⌘-click to open in a web tab, ⌘⇧-click for the browser');
    expect(hyperlinkHint('https://github.com/o/r/pull/12', false, keys)).toBe('https://github.com/o/r/pull/12 — ⌘-click to open in the browser');
  });

  test("a target that may not be opened is named, with that it can't be", () => {
    expect(hyperlinkHint('http://example.com/docs', true, keys)).toBe("http://example.com/docs — can't be opened from here: only https, or http on this machine");
  });

  test('the address shown is the parsed one that opens, not the target as written', () => {
    expect(hyperlinkHint("https://example.com/it's", true, keys)).toMatch(/^https:\/\/example\.com\/it's — /);
    expect(hyperlinkHint('HTTPS://EXAMPLE.COM/a', true, keys)).toMatch(/^https:\/\/example\.com\/a — /);
    // A right-to-left override is encoded in the path, and a lookalike host is punycode.
    expect(hyperlinkHint('https://example.com/\u202egpj.exe', true, keys)).toMatch(/^https:\/\/example\.com\/%E2%80%AEgpj\.exe — /);
    expect(hyperlinkHint('https://аpple.com/', true, keys)).toMatch(/^https:\/\/xn--/);
  });

  test('a very long target is cut short', () => {
    expect(hyperlinkHint(`https://example.com/${'a'.repeat(500)}`, true, keys).length).toBeLessThan(400);
  });
});
