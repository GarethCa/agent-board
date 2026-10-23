import { describe, expect, it } from 'vitest';
import { searchShapes } from './search';

const names = (query: string) => searchShapes(query).map(({ shape }) => shape);

describe('searchShapes', () => {
  it('finds a shape by the start of its name first, then by another word for it, then by its letters in order', () => {
    expect(names('da')).toEqual(['database', 'input-output', 'storage', 'delay']);
    const [database, io] = searchShapes('da');
    expect(database).toEqual({ shape: 'database', match: { in: 'name', text: 'Database', from: 0, to: 2 } });
    expect(io).toEqual({ shape: 'input-output', match: { in: 'synonym', text: 'data', from: 0, to: 2 } });
  });

  it('knows the words people use for a shape', () => {
    expect(names('db')[0]).toBe('database');
    expect(names('person').slice(0, 2)).toEqual(['user', 'actor']);
    expect(names('kafka')[0]).toBe('queue');
    expect(names('if')[0]).toBe('diamond');
  });

  it('matches any word of a name, ignoring case and the space around the query', () => {
    expect(names('  BALANCER ')[0]).toBe('load-balancer');
    expect(names('output')[0]).toBe('input-output');
  });

  it('gives every shape in its order for an empty query, and none for nonsense', () => {
    expect(names('')).toHaveLength(43);
    expect(names('')[0]).toBe('rectangle');
    expect(names('zzzq')).toEqual([]);
  });
});
