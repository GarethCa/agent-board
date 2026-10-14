import { describe, expect, it } from 'vitest';
import { lineSplitter, ZONE_COLOR_NAMES, ZONE_COLORS } from '../src/protocol.ts';

function split(chunks: string[], maxLength?: number) {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line), maxLength);
  const accepted = chunks.map((chunk) => feed(chunk));
  return { lines, accepted };
}

describe('lineSplitter', () => {
  it('reassembles lines split across chunks and splits several lines in one chunk', () => {
    expect(split(['{"a":', '1}\n{"b"', ':2}\n{"c":3}\n']).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('holds a trailing partial line until its newline arrives', () => {
    expect(split(['one\ntw']).lines).toEqual(['one']);
    expect(split(['one\ntw', 'o\n']).lines).toEqual(['one', 'two']);
  });

  it('skips blank lines', () => {
    expect(split(['\n\none\n  \n']).lines).toEqual(['one']);
  });

  it('reports an unfinished line that has grown past the limit', () => {
    expect(split(['12345', '678'], 6).accepted).toEqual([true, false]);
    expect(split(['12345\n', '678'], 6).accepted).toEqual([true, true]);
  });
});

describe('zone colours', () => {
  it('each have a name, and no two share one', () => {
    const names = ZONE_COLORS.map((color) => ZONE_COLOR_NAMES[color]);
    expect(names.every((name) => typeof name === 'string' && name !== '')).toBe(true);
    expect(new Set(names).size).toBe(ZONE_COLORS.length);
  });
});
