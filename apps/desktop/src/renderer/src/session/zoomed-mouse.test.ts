import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Terminal } from '@xterm/xterm';
import { compensateForScale, unscalePoint } from './zoomed-mouse';

const element = (rect: { left: number; top: number; width: number; height: number }, offset: { w: number; h: number }) =>
  ({ getBoundingClientRect: () => rect, offsetWidth: offset.w, offsetHeight: offset.h }) as unknown as HTMLElement;

describe('unscalePoint', () => {
  it('leaves a point alone at scale 1', () => {
    const el = element({ left: 100, top: 50, width: 400, height: 200 }, { w: 400, h: 200 });
    expect(unscalePoint({ clientX: 150, clientY: 80 }, el)).toEqual({ clientX: 150, clientY: 80 });
  });

  it('rescales about the on-screen origin by the inverse of the scale', () => {
    const half = element({ left: 100, top: 50, width: 200, height: 100 }, { w: 400, h: 200 });
    expect(unscalePoint({ clientX: 150, clientY: 80 }, half)).toEqual({ clientX: 200, clientY: 110 });
    const double = element({ left: 100, top: 50, width: 800, height: 400 }, { w: 400, h: 200 });
    expect(unscalePoint({ clientX: 300, clientY: 150 }, double)).toEqual({ clientX: 200, clientY: 100 });
  });

  it('leaves a point alone when the element has no layout size', () => {
    const el = element({ left: 0, top: 0, width: 0, height: 0 }, { w: 0, h: 0 });
    expect(unscalePoint({ clientX: 5, clientY: 5 }, el)).toEqual({ clientX: 5, clientY: 5 });
  });
});

describe('compensateForScale', () => {
  const half = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }), offsetWidth: 400, offsetHeight: 200 } as unknown as HTMLElement;

  it('rescales the pointer for both the selection and the mouse-report mapping', () => {
    const seen: unknown[] = [];
    const service = { getCoords: (...args: unknown[]) => seen.push(args[0]), getMouseReportCoords: (...args: unknown[]) => seen.push(args[0]) };
    compensateForScale({ _core: { _mouseService: service } } as unknown as Terminal);
    service.getCoords({ clientX: 150, clientY: 80 }, half);
    service.getMouseReportCoords({ clientX: 150, clientY: 80 }, half);
    expect(seen).toEqual([
      { clientX: 200, clientY: 110 },
      { clientX: 200, clientY: 110 },
    ]);
  });

  it('warns loudly when xterm has no mouse service to patch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    compensateForScale({} as Terminal);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('_mouseService'));
    warn.mockRestore();
  });

  // The patch reaches into xterm's private fields. If an upgrade renames them this fails, not just the e2e.
  it('still matches the shipped xterm internals it patches', () => {
    const bundle = readFileSync(createRequire(import.meta.url).resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
    for (const name of ['_core', '_mouseService', 'getMouseReportCoords', 'getCoords']) expect(bundle, name).toContain(name);
  });
});
