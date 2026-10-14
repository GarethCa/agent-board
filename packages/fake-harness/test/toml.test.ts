import { describe, expect, it } from 'vitest';
import { parseTomlValue } from '../src/toml.ts';

describe('TOML values in -c overrides', () => {
  it.each<[string, unknown]>([
    ['"a \\"b\\" \\\\ \\u00e9"', 'a "b" \\ é'],
    ["'C:\\raw'", 'C:\\raw'],
    ['5', 5],
    ['-3', -3],
    ['true', true],
    ['[1, "two", [false]]', [1, 'two', [false]]],
    ['[]', []],
    ['{a=1, "b c"="d", e.f=2}', { a: 1, 'b c': 'd', e: { f: 2 } }],
    ['[{hooks=[{type="command",command="\\"/x y/hook\\" codex",timeout=600}]}]', [{ hooks: [{ type: 'command', command: '"/x y/hook" codex', timeout: 600 }] }]],
  ])('%s', (text, value) => {
    expect(parseTomlValue(text)).toEqual(value);
  });

  it.each(['', '[1,', '{a=}', '"open', '1 2', 'bare'])('rejects %j', (text) => {
    expect(() => parseTomlValue(text)).toThrow();
  });
});
