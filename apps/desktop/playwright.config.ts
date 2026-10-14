import { defineConfig } from '@playwright/test';

const PERF = /board-perf\.spec\.ts/;
const PACKAGED = /packaged\.spec\.ts/;
const VISUAL = /visual\.spec\.ts/;
const README = /readme-screenshots\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  projects: [
    { name: 'app', testIgnore: [PERF, PACKAGED, VISUAL, README] },
    // Screenshots against per-platform baselines, run by `pnpm test:visual` and the visual steps of `pnpm check:local`.
    { name: 'visual', testMatch: VISUAL },
    // The README's screenshots, written to docs/assets/screenshots by `pnpm readme:screenshots`; no test run takes them.
    { name: 'readme', testMatch: README },
    // Frame timings are only meaningful with no other app running, so the benchmark waits for the rest.
    { name: 'perf', testMatch: PERF, dependencies: ['app'] },
    // The .app from `pnpm package`, run on its own by `pnpm test:e2e:packaged` (it needs packaging first).
    { name: 'packaged', testMatch: PACKAGED },
  ],
});
