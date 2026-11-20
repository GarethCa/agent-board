import { expect, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { launch, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

/**
 * What the frost behind an agent's pop-up costs, run by hand (`pnpm --filter @agent-board/desktop exec playwright test
 * popup-frost-bench --project bench`), never by a gate. With the pop-up up, the board under it moves every frame, the
 * worst case for a blur, as the board's layer is moved by script one step a frame. Then the board stands still while
 * the pop-up's own terminal draws. Every agent is in a turn that never ends (the fake's `busy` scenario), so the pop-up's
 * terminal and the live tiles behind the frost redraw throughout. Each case runs with the frost on and off, three times
 * over, and the frame gaps are written out (p50, p95, max) beside the display's own frame.
 */
const AGENTS = 3;
const ROUNDS = 3;
const FRAMES = 180;

interface Gaps {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function summarise(gaps: number[]): Gaps {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1));
  return { frames: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}

/** The gaps between `FRAMES` frames, the board's layer moved before each when `step` is `pan`. */
function framesWhile(window: Page, step: 'pan' | 'still'): Promise<number[]> {
  return window.evaluate(
    ([frames, moving]) =>
      new Promise<number[]>((resolve) => {
        const layer = document.querySelector<HTMLElement>('.react-flow__viewport')!;
        const from = layer.style.transform;
        const gaps: number[] = [];
        let last = performance.now();
        let left = frames;
        const tick = (now: number) => {
          gaps.push(now - last);
          last = now;
          if (moving) layer.style.transform = `translate(${Math.sin(left / 12) * 200}px, ${Math.cos(left / 15) * 120}px) scale(1)`;
          if (--left > 0) requestAnimationFrame(tick);
          else {
            layer.style.transform = from;
            resolve(gaps.slice(1));
          }
        };
        requestAnimationFrame((now) => {
          last = now;
          requestAnimationFrame(tick);
        });
      }),
    [FRAMES, step === 'pan'] as const,
  );
}

const setFrost = (window: Page, on: boolean) =>
  window.evaluate((value) => {
    if (value === null) localStorage.removeItem('agent-board.popup-frost');
    else localStorage.setItem('agent-board.popup-frost', value);
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'agent-board.popup-frost' }));
  }, on ? null : 'off');

test('the frost behind a pop-up stays cheap while the board moves under it and its terminal draws', async () => {
  test.setTimeout(240_000);
  const { dir, repo, env } = scratch('busy');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    for (let n = 1; n <= AGENTS; n++) await spawnAgent(window, 'monorepo', `Keep busy: refactor store ${n}`);
    for (let n = 0; n < AGENTS; n++) await expect(tile(window).nth(n)).toHaveAttribute('data-state', 'running', { timeout: TURN_MS });
    await tile(window).first().dblclick();
    const scrim = window.getByTestId('agent-popup-scrim');
    await expect(scrim).toBeVisible();

    const frameMs = summarise(await framesWhile(window, 'still')).p50Ms;
    const results: Record<string, Gaps[]> = {};
    const record = (name: string, gaps: number[]) => (results[name] ??= []).push(summarise(gaps));
    for (let round = 0; round < ROUNDS; round++)
      for (const frost of [true, false]) {
        await setFrost(window, frost);
        await expect(scrim).toHaveCSS('backdrop-filter', frost ? /blur/ : 'none');
        const label = frost ? 'frost' : 'dim';
        record(`${label}: board moving`, await framesWhile(window, 'pan'));
        record(`${label}: terminals drawing`, await framesWhile(window, 'still'));
      }
    // Still in their turns at the end, so every round had them drawing.
    for (let n = 0; n < AGENTS; n++) await expect(tile(window).nth(n)).toHaveAttribute('data-state', 'running');
    const result = { frameMs, rounds: ROUNDS, framesEach: FRAMES, results };
    const path = test.info().outputPath('popup-frost-bench.json');
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    await test.info().attach('popup-frost-bench', { path, contentType: 'application/json' });
    console.log(`popup frost bench: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
