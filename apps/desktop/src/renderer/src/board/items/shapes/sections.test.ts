import { describe, expect, it } from 'vitest';
import { shapeData } from '../text-style';
import { kindChange, sectionTexts, shapeWords, stereotyped } from './sections';

describe("a shape's sections", () => {
  it('has the attributes and methods for a class or a box interface, and none for a kind without', () => {
    expect(sectionTexts(shapeData({ shape: 'class', attributes: '+ id: string' }))).toEqual([
      { section: 'attributes', text: '+ id: string' },
      { section: 'methods', text: '' },
    ]);
    expect(sectionTexts(shapeData({ shape: 'interface-box' })).map(({ section }) => section)).toEqual(['attributes', 'methods']);
    expect(sectionTexts(shapeData({ shape: 'rectangle', attributes: 'kept' }))).toEqual([]);
  });

  it('says all it has: its text, then each section that has any, under its name', () => {
    expect(shapeWords(shapeData({ shape: 'class', text: 'Session', methods: '+ send(text)' }))).toBe('Session\nmethods:\n+ send(text)');
    expect(shapeWords(shapeData({ shape: 'class', text: 'Session', attributes: '+ id', methods: '+ send()' }))).toBe(
      'Session\nattributes:\n+ id\nmethods:\n+ send()',
    );
    expect(shapeWords(shapeData({ shape: 'rectangle', text: 'API', attributes: 'hidden' }))).toBe('API');
  });
});

describe("a class name's stereotype", () => {
  it('is a first line in guillemets, or in double angle brackets, shown with guillemets', () => {
    expect(stereotyped('«entity»\nSession')).toEqual({ stereotype: '«entity»', name: 'Session' });
    expect(stereotyped(' <<interface>> \nRunner')).toEqual({ stereotype: '«interface»', name: 'Runner' });
  });

  it('is none for a name without one, or one alone on a line it shares', () => {
    expect(stereotyped('Session')).toEqual({ stereotype: null, name: 'Session' });
    expect(stereotyped('«entity» Session')).toEqual({ stereotype: null, name: '«entity» Session' });
    expect(stereotyped('«entity»')).toEqual({ stereotype: '«entity»', name: '' });
  });

  it("is the kind's own when the name gives none, and the name's when it does", () => {
    expect(stereotyped('Runner', '«interface»')).toEqual({ stereotype: '«interface»', name: 'Runner' });
    expect(stereotyped('«abstract»\nRunner', '«interface»')).toEqual({ stereotype: '«abstract»', name: 'Runner' });
  });
});

describe('changing a shape to another kind', () => {
  it('takes the new kind\'s mono when one has sections and the other not: Class, then Process, then Class', () => {
    const asClass = shapeData({ shape: 'class' });
    const asProcess = shapeData({ ...asClass, ...kindChange(asClass, 'rectangle') });
    expect(asProcess).toMatchObject({ shape: 'rectangle', mono: false });
    expect(shapeData({ ...asProcess, ...kindChange(asProcess, 'class') })).toMatchObject({ shape: 'class', mono: true });
  });

  it('keeps the mono set between two kinds alike', () => {
    expect(kindChange(shapeData({ shape: 'class', mono: false }), 'interface-box')).toEqual({ shape: 'interface-box' });
    expect(kindChange(shapeData({ shape: 'rectangle', mono: true }), 'ellipse')).toEqual({ shape: 'ellipse' });
  });
});

