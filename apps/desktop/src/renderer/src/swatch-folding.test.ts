import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { COLOR_SLOTS, FILL_SLOTS } from '@agent-board/daemon/protocol';
import { covers, foldAlike, foldColors, foldFills, foldLines, type ReadToken } from './board-colors';
import { THEMES } from '../../shared/themes';

const here = import.meta.dirname;

/** Each `:root` block of a stylesheet, by its `data-theme` (`light` for the bare `:root`), with its declarations. */
function blocks(file: string): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  postcss.parse(readFileSync(join(here, file), 'utf8')).walkRules((rule) => {
    const theme = /^:root(?:\[data-theme='([^']+)'\])?$/.exec(rule.selector)?.[1] ?? (rule.selector === ':root' ? 'light' : undefined);
    if (theme === undefined) return;
    const declarations = found.get(theme) ?? new Map<string, string>();
    rule.walkDecls((decl) => {
      declarations.set(decl.prop, decl.value.trim());
    });
    found.set(theme, declarations);
  });
  return found;
}

const sheets = [blocks('tokens.css'), blocks('theme-packs.css')];
const light = sheets[0]!.get('light')!;

/** What a theme resolves `name` to: its own value, or the light theme's. */
const resolver = (id: string) => {
  const own = sheets.map((sheet) => sheet.get(id)).filter((block) => block !== undefined);
  return (name: string) => {
    const value = [...own.map((block) => block.get(name)), light.get(name)].find((found) => found !== undefined);
    if (value === undefined) throw new Error(`${id} has no ${name}`);
    return value;
  };
};

describe('foldAlike', () => {
  const colours: Record<string, string> = { a: '#111111', b: '#222222', c: '#111111', d: '#222222', e: '#333333' };

  it('shows each distinct look once, in slot order, the first slot standing for the later ones', () => {
    expect(foldAlike(['a', 'b', 'c', 'd', 'e'], (slot) => colours[slot]!)).toEqual([
      { slot: 'a', also: ['c'] },
      { slot: 'b', also: ['d'] },
      { slot: 'e', also: [] },
    ]);
  });

  it('reads alike from the looks, not from the slots’ names, and whatever their case', () => {
    expect(foldAlike(['x', 'y'], (slot) => (slot === 'x' ? '#ABCDEF' : ' #abcdef '))).toEqual([{ slot: 'x', also: ['y'] }]);
  });

  it('folds nothing when no two slots look alike', () => {
    expect(foldAlike(['a', 'b', 'e'], (slot) => colours[slot]!).map(({ also }) => also)).toEqual([[], [], []]);
  });
});

describe('covers', () => {
  const group = { slot: 'accent', also: ['blue'] };

  it('is true for the first slot and the ones folded into it, and false for any other, or none', () => {
    expect(covers(group, 'accent')).toBe(true);
    expect(covers(group, 'blue')).toBe(true);
    expect(covers(group, 'red')).toBe(false);
    expect(covers(group, null)).toBe(false);
  });
});

const rowOf = (id: string) => foldColors(resolver(id));

describe.each(THEMES)('folded colour rows in $id', ({ id }) => {
  const read = resolver(id);

  it.each([
    ['colour', foldColors(read), COLOR_SLOTS],
    ['line', foldLines(read), COLOR_SLOTS.filter((slot) => slot !== 'ink')],
    ['fill', foldFills(read), FILL_SLOTS.filter((slot) => slot !== 'tile')],
  ] as const)('the %s row has every slot in exactly one swatch', (_name, shown, slots) => {
    expect(shown.flatMap(({ slot, also }) => [slot, ...also]).sort()).toEqual([...slots].sort());
  });

  it('shows the fills in their own order, and names a colour as the colour rows do', () => {
    const fills = foldFills(read);
    const order = FILL_SLOTS.filter((slot) => fills.some((group) => group.slot === slot));
    expect(fills.map(({ slot }) => slot)).toEqual(order);
    // The colour row's winner is the fill row's too, wherever both have it.
    const colourWinner = (slot: string) => rowOf(id).find((group) => covers(group, slot))!.slot;
    for (const { slot } of fills) expect(slot).toBe(colourWinner(slot));
  });
});

describe('the number of swatches in the colour rows', () => {
  it.each([
    ['catppuccin-latte', 11, ['blue']],
    ['nord', 10, ['cyan', 'pink']],
    ['dracula', 8, ['yellow', 'teal']],
  ])('%s shows %i colours, with %j folded into another', (id, count, folded) => {
    const row = rowOf(id!);
    expect(row).toHaveLength(count as number);
    expect(row.flatMap(({ also }) => also)).toEqual(expect.arrayContaining(folded as string[]));
  });

  it('folds Accent over Blue in Latte, Orange/Yellow and Green/Teal in Dracula, in the fill row as well', () => {
    expect(rowOf('catppuccin-latte').find(({ slot }) => slot === 'accent')?.also).toContain('blue');
    expect(rowOf('dracula').find(({ slot }) => slot === 'orange')?.also).toContain('yellow');
    expect(rowOf('dracula').find(({ slot }) => slot === 'green')?.also).toContain('teal');
    expect(foldFills(resolver('dracula')).find(({ slot }) => slot === 'orange')?.also).toContain('yellow');
  });

  it('shows each light-theme colour on its own', () => {
    expect(rowOf('light')).toHaveLength(12);
  });
});

describe('the Simplified design', () => {
  /** The tokens a Simplified design block sets: `blocks` reads theme blocks alone, so it never sees these. */
  const simplifiedSets = (selector: string) => {
    const names = new Set<string>();
    postcss.parse(readFileSync(join(here, 'tokens.css'), 'utf8')).walkRules((rule) => {
      if (rule.selector === selector) rule.walkDecls((decl) => void names.add(decl.prop));
    });
    return names;
  };

  it.each([":root[data-design='simplified']", ":root[data-design='simplified'][data-theme='dark']"])(
    '%s sets none of the tokens the colour rows read, so they fold as in the app’s own theme in its mode',
    (selector) => {
      const set = simplifiedSets(selector);
      expect(set.size).toBeGreaterThan(0);
      const read = new Set<string>();
      const recording: ReadToken = (name) => {
        read.add(name);
        return resolver('light')(name);
      };
      foldColors(recording);
      foldLines(recording);
      foldFills(recording);
      expect(read.size).toBeGreaterThan(0);
      expect([...read].filter((name) => set.has(name))).toEqual([]);
    },
  );
});
