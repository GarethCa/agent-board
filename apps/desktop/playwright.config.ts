import { defineConfig } from '@playwright/test';
import { cpus, loadavg } from 'node:os';
import { defaultWorkers } from '../../scripts/e2e-lock/workers.ts';

const PERF = /board-perf\.spec\.ts/;
const PACKAGED = /packaged\.spec\.ts/;
const VISUAL = /visual\.spec\.ts/;
const README = /readme-screenshots\.spec\.ts/;
/** The board recordings for the promo: the capture spike and one spec per storyboard shot. */
const PROMO = /(^|\/)e2e\/capture\/[^/]+\.spec\.ts$/;
/** How many tests run at once: 3 (2 when the load average is above the core count), or `AGENT_BOARD_E2E_WORKERS`, a count or a share of the cores such as `50%`. */
function workers(): number | string {
  const value = process.env.AGENT_BOARD_E2E_WORKERS;
  if (value === undefined) return defaultWorkers(loadavg()[0]!, cpus().length);
  if (/^[1-9]\d*%?$/.test(value)) return value.endsWith('%') ? value : Number(value);
  throw new Error(`AGENT_BOARD_E2E_WORKERS is ${value}: give a count such as 2, or a share of the cores such as 50%`);
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Three tests at once, not Playwright's default of half the cores: each launches an Electron app and a daemon, and the
  // load, not WindowServer, is what stalls the Mac when gates overlap. On a 10-core Mac three took 28% longer than five,
  // used 14% less CPU and brought the load mean from 17.6 to 11.2. `AGENT_BOARD_E2E_WORKERS` overrides it.
  workers: workers(),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  projects: [
    { name: 'app', testIgnore: [PERF, PACKAGED, VISUAL, README, PROMO] },
    // Screenshots against per-platform baselines, run by `pnpm test:visual` and the visual steps of `pnpm check:local`.
    { name: 'visual', testMatch: VISUAL },
    // The README's screenshots, written to docs/assets/screenshots by `pnpm readme:screenshots`; no test run takes them.
    { name: 'readme', testMatch: README },
    // Recordings of the board for the promo video, made by `pnpm promo:capture` (and the spike's by `promo:spike`); no gate runs them.
    { name: 'promo', testMatch: PROMO },
    // Frame timings are only meaningful with no other app running, so the benchmark waits for the rest.
    { name: 'perf', testMatch: PERF, dependencies: ['app'] },
    // The .app from `pnpm package`, run on its own by `pnpm test:e2e:packaged` (it needs packaging first).
    { name: 'packaged', testMatch: PACKAGED },
  ],
});
