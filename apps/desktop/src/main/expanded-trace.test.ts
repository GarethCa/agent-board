import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendTraceLine, traceLine } from './expanded-trace';

const AT = new Date('2026-11-17T20:37:53.489Z');
const view = { x: -120.27, y: 40, zoom: 0.8 };

describe('traceLine', () => {
  it('writes a collapse as one line: when, the code path, its trigger, where the keyboard was, the tiles, and the view before and after', () => {
    expect(traceLine({ kind: 'collapse', path: 'collapseFront', trigger: 'keydown Escape', focus: 'page', tiles: ['agent-1', 'agent-2'], before: view, after: view }, AT)).toBe(
      '2026-11-17T20:37:53.489Z collapse path=collapseFront trigger="keydown Escape" focus=page tiles=agent-1,agent-2 before=-120.3,40,0.8 after=-120.3,40,0.8',
    );
  });

  it('writes a collapse a pin refused as a kept line, with the tiles it kept open', () => {
    expect(traceLine({ kind: 'kept', path: 'collapseFront', trigger: 'keydown Escape', focus: 'terminal', tiles: ['agent-1'], before: view, after: view }, AT)).toBe(
      '2026-11-17T20:37:53.489Z kept path=collapseFront trigger="keydown Escape" focus=terminal tiles=agent-1 before=-120.3,40,0.8 after=-120.3,40,0.8',
    );
  });

  it('keeps a collapse of many tiles, its first twenty named and the rest counted', () => {
    const tiles = Array.from({ length: 32 }, (_, at) => `agent-${at}`);
    const line = traceLine({ kind: 'collapse', path: 'keepExpanded', trigger: 'tile-gone', focus: 'page', tiles, before: view, after: view }, AT);
    expect(line).toContain(` tiles=${tiles.slice(0, 20).join(',')},+12more `);
  });

  it('writes a view move with the view before and after', () => {
    expect(traceLine({ kind: 'view', path: 'bringIntoView', trigger: 'none', focus: 'terminal', before: view, after: { x: 10, y: 20, zoom: 1 } }, AT)).toBe(
      '2026-11-17T20:37:53.489Z view path=bringIntoView trigger="none" focus=terminal before=-120.3,40,0.8 after=10,20,1',
    );
  });

  it('refuses anything that is not a known shape, so no text a terminal shows or a prompt holds gets in', () => {
    const ok = { kind: 'collapse', path: 'collapse', trigger: 'click', focus: 'tile', tiles: ['agent-1'], before: view, after: view };
    expect(traceLine(ok, AT)).toBeDefined();
    expect(traceLine(null, AT)).toBeUndefined();
    expect(traceLine({ ...ok, kind: 'other' }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, trigger: 'keydown "rm -rf /"\nnext line' }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, path: 'a'.repeat(81) }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, focus: 'my prompt here' }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, tiles: [] }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, tiles: ['agent 1; echo', 'agent-2'] }, AT)).toContain(' tiles=?,agent-2 ');
    expect(traceLine({ ...ok, tiles: 'agent-1' }, AT)).toBeUndefined();
    expect(traceLine({ ...ok, before: { x: Number.NaN, y: 0, zoom: 1 } }, AT)).toBeUndefined();
    expect(traceLine({ kind: 'view', path: 'flyTo', trigger: 'none', focus: 'page', before: view }, AT)).toBeUndefined();
  });
});

describe('appendTraceLine', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('appends each line, and once the file would pass its cap starts it again, keeping the last one beside it', () => {
    dir = mkdtempSync(join(tmpdir(), 'expanded-trace-'));
    const log = join(dir, 'expanded-tiles.log');
    appendTraceLine(log, 'one', 12);
    appendTraceLine(log, 'two', 12);
    expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n');
    appendTraceLine(log, 'three', 12);
    expect(readFileSync(log, 'utf8')).toBe('three\n');
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('one\ntwo\n');
    appendTraceLine(log, 'four', 12);
    appendTraceLine(log, 'five', 12);
    expect(readFileSync(log, 'utf8')).toBe('five\n');
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('three\nfour\n');
  });

  it('never throws when it cannot write', () => {
    dir = mkdtempSync(join(tmpdir(), 'expanded-trace-'));
    const blocked = join(dir, 'file');
    writeFileSync(blocked, '');
    expect(() => appendTraceLine(join(blocked, 'expanded-tiles.log'), 'line')).not.toThrow();
    expect(existsSync(join(blocked, 'expanded-tiles.log'))).toBe(false);
  });
});
