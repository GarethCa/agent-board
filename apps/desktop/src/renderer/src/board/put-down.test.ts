import { describe, expect, it } from 'vitest';
import { keepPutDown, putDownFrom, putDownIds, puttingDown, savedPutDown, withoutPutDown } from './put-down';

const open = (...ids: string[]) => new Set(ids);

describe('the tiles put down while tiles are expanded', () => {
  it('remembers a tile put down with the tiles open then, in any order', () => {
    const put = puttingDown(new Map(), ['agent:a2'], ['agent:b', 'agent:a1']);

    expect([...put]).toEqual([['agent:a2', ['agent:a1', 'agent:b']]]);
    expect(putDownIds(put)).toEqual(new Set(['agent:a2']));
  });

  it('forgets a tile put down again with nothing open: its saved place has no push in it', () => {
    const put = puttingDown(new Map([['agent:a2', ['agent:a1']]]), ['agent:a2'], []);

    expect(put.size).toBe(0);
  });

  it('is left alone by another expanded tile opening', () => {
    const put = puttingDown(new Map(), ['agent:a2'], ['agent:a1']);

    // Another expanded elsewhere: the tile it was put beside is still open.
    expect(keepPutDown(put, open('agent:other', 'agent:a1'))).toBe(put);
  });

  it('keeps a tile while any of the tiles open when it was put down is still open, and forgets it once all have closed', () => {
    const put = puttingDown(new Map(), ['agent:a2'], ['agent:a1', 'agent:b']);

    const oneClosed = keepPutDown(put, open('agent:b'));
    expect([...oneClosed]).toEqual([['agent:a2', ['agent:b']]]);
    // A tile opened later is no tile it was put beside.
    expect(keepPutDown(oneClosed, open('agent:c')).size).toBe(0);
  });

  it('forgets a tile that is gone, or moved any other way', () => {
    const put = puttingDown(new Map(), ['agent:a2', 'shell:s'], ['agent:a1']);

    expect([...withoutPutDown(put, ['shell:s']).keys()]).toEqual(['agent:a2']);
    expect(withoutPutDown(put, ['agent:none'])).toBe(put);
  });

  it('comes back from the view as it was saved, and leaves out anything else', () => {
    const put = puttingDown(new Map(), ['shell:s', 'agent:a2'], ['agent:a1']);

    expect(putDownFrom(JSON.parse(JSON.stringify(savedPutDown(put))))).toEqual(put);
    expect(putDownFrom(null).size).toBe(0);
    expect([...putDownFrom([['agent:x', ['agent:a1', 3]], ['agent:y', []], 'z', [1, ['agent:a1']]])]).toEqual([['agent:x', ['agent:a1']]]);
  });
});
