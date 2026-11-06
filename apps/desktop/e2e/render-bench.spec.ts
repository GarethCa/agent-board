import { expect, type ElectronApplication } from '@playwright/test';
import type { DaemonClient } from '@agent-board/daemon/client';
import { EXPANDED_VIEW_KEY, tileSizeKey } from '@agent-board/daemon/board-layout';
import { STICKY_COLORS, type Shell } from '@agent-board/daemon/protocol';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { SHELL_ENV } from './agent-helpers.ts';
import { bringTo, countRenders, installRecorders, pan, phase, tracer, zoomTo, type Phase } from './bench-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/**
 * The rendering benchmark, run by hand (`pnpm bench:render`), never by a gate:
 * a board of shells with long scrollback, each expanded in place with its live terminal, beside many notes, zoomed and
 * panned while frame gaps, long tasks, terminal mounts and memory are recorded. Plain `sh` sessions stand in for agents:
 * the board draws an agent's terminal and a shell's alike, and nothing here spends a token.
 *
 * From the environment: `BENCH_SHELLS` (20), `BENCH_LINES` of scrollback each (8000), `BENCH_LIVE` shells that keep
 * printing a line every half second (5), `BENCH_NOTES` agent notes and as many sticky notes (60), `BENCH_TRACE=1` to
 * save a DevTools trace of each phase beside the results, `BENCH_CPU_SLOWDOWN` to throttle the renderer's CPU (4 for a
 * slower laptop), and `BENCH_APP_ENV` (JSON) for more of the app's environment.
 * `AGENT_BOARD_HEADED=1` draws on the display, at its own refresh rate; without it the window paints offscreen at 60 Hz.
 */
const SIZE = {
  shells: Number(process.env.BENCH_SHELLS ?? 20),
  lines: Number(process.env.BENCH_LINES ?? 8000),
  live: Number(process.env.BENCH_LIVE ?? 5),
  notes: Number(process.env.BENCH_NOTES ?? 60),
};
const TRACE = process.env.BENCH_TRACE === '1';
/** How many times slower the renderer's CPU runs (DevTools' CPU throttling), to stand in for a slower laptop: 1, none, by default. */
const CPU_SLOWDOWN = Number(process.env.BENCH_CPU_SLOWDOWN ?? 1);
// The renderer the app gives its users, where the e2e specs keep to the DOM one.
const APP_ENV = { AGENT_BOARD_TERMINAL_RENDERER: 'auto', ...(JSON.parse(process.env.BENCH_APP_ENV ?? '{}') as Record<string, string>) };

/** How big each shell's tile is expanded, and how far apart the tiles are laid out, in board px. */
const EXPANDED = { width: 720, height: 460 };
const COLUMNS = 5;
const PITCH = { x: 820, y: 560 };
/** Where the notes start: below the shells, the sticky notes on the left and the agent notes right of them. */
const NOTES_TOP = Math.ceil(SIZE.shells / COLUMNS) * PITCH.y + 400;
const NOTE_PITCH = 300;
const AGENT_NOTES_LEFT = 10 * NOTE_PITCH + 400;

const NOTE_TEXT = [
  '**Plan**: move the session store to SQLite.',
  '- read the old JSON once',
  '- write rows in one transaction',
  '- keep a backup for a release',
  '',
  'Then _measure_ the start-up time again, and `vacuum` once a week.',
].join('\n');

/** Fills the board through the daemon: the shells, their scrollback (and a live line in some), and the notes. */
async function seed(client: DaemonClient): Promise<Shell[]> {
  const shells: Shell[] = [];
  for (let index = 0; index < SIZE.shells; index++) {
    const position = { x: (index % COLUMNS) * PITCH.x, y: Math.floor(index / COLUMNS) * PITCH.y };
    shells.push(await client.call('shell.create', { zoneId: null, position }));
  }
  // Coloured, numbered lines, as an agent's transcript has: scrollback the daemon keeps and sends on every attachment.
  const fill = `awk 'BEGIN { for (i = 0; i < ${SIZE.lines}; i++) printf "\\033[3%dm%06d\\033[0m \\033[1mtool\\033[0m Read src/session/store-%d.ts: the quick brown fox jumps over the lazy dog\\n", i % 7 + 1, i, i % 97 }'`;
  const live = 'while :; do date; sleep 0.5; done';
  for (const [index, shell] of shells.entries()) {
    await client.call('session.write', { sessionId: paneOf(shell), data: `${fill}${index < SIZE.live ? `; ${live}` : ''}\n` });
  }
  for (let index = 0; index < SIZE.notes; index++) {
    const x = (index % 10) * NOTE_PITCH;
    const y = NOTES_TOP + Math.floor(index / 10) * NOTE_PITCH;
    await client.call('item.create', { kind: 'sticky', zoneId: null, x, y, width: 200, height: 200, data: { text: NOTE_TEXT, color: STICKY_COLORS[index % STICKY_COLORS.length]!.value } });
    await client.call('item.create', {
      kind: 'agent-note',
      zoneId: null,
      x: AGENT_NOTES_LEFT + x,
      y,
      width: 272,
      height: 260,
      data: { text: NOTE_TEXT, agent: { sessionId: '', name: 'lead', harness: 'claude', role: 'orchestrator' }, writtenAt: '2026-10-28T12:00:00.000Z', editedByUser: false },
    });
  }
  // Let the shells print their scrollback.
  await sleep(3000);
  return shells;
}

const paneOf = (shell: Shell): string => {
  if (shell.layout.type !== 'pane') throw new Error('a new shell has one pane');
  return shell.layout.sessionId;
};

test.describe.configure({ timeout: 900_000 });

test('rendering benchmark: terminals coming into view, many notes, pan and zoom', async () => {
  const dataDir = tempDataDir();
  let first: ElectronApplication | undefined;
  let app: ElectronApplication | undefined;
  try {
    // The daemon outlives the app: the board is filled while a first app runs, and the shells' expansion saved once it
    // has closed (an open board saves its own), so the second opens on every shell expanded.
    first = await launchApp(dataDir, { ...SHELL_ENV, ...APP_ENV });
    await connectedDaemonPid(await first.firstWindow());
    const shells = await withDaemon(dataDir, seed);
    await first.close();
    first = undefined;
    await withDaemon(dataDir, (client) =>
      client.call('view.set', { key: EXPANDED_VIEW_KEY, value: shells.map((shell) => ({ id: tileSizeKey('shell', shell.id), ...EXPANDED })) }),
    );
    const board = (app = await launchApp(dataDir, { ...SHELL_ENV, ...APP_ENV }));
    const window = await board.firstWindow();
    const daemonPid = await connectedDaemonPid(window);
    // The render counter must be in place before React loads: the board is loaded again with it.
    await board.context().addInitScript(countRenders);
    await window.reload();
    await connectedDaemonPid(window);
    if (SIZE.shells > 0) await expect(window.getByTestId('expanded-tile')).not.toHaveCount(0);
    else if (SIZE.notes > 0) await expect(window.getByTestId('sticky')).not.toHaveCount(0);
    await installRecorders(window);
    const cdp = await board.context().newCDPSession(window);
    const trace = TRACE ? tracer(cdp) : undefined;
    if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    const phases: Phase[] = [];
    const run = async (name: string, input: () => Promise<void>) => {
      phases.push(await phase(board, window, cdp, name, input, { trace, daemonPid }));
      console.log(JSON.stringify(phases.at(-1)));
    };

    // The board opens fitted to everything: every terminal and note is drawn.
    await sleep(3000);
    await run('overview, idle', () => sleep(5000));
    // Into the first shell, at the zoom one works at: the others leave the view.
    await bringTo(window, EXPANDED.width / 2, EXPANDED.height / 2, centre);
    await run('zoom in to a shell', () => zoomTo(window, 1, centre));
    await run('one shell, idle', () => sleep(5000));
    // Panning to the next shell along, three times, then down a row: each one comes into view as it is reached.
    await run('pan to the next shells', async () => {
      for (let column = 1; column < 4; column++) {
        await pan(window, PITCH.x, 0);
        await sleep(400);
      }
      await pan(window, 0, PITCH.y);
    });
    await run('pan back over them', () => pan(window, -3 * PITCH.x, -PITCH.y));
    // The notes, at the same zoom: down to the sticky notes, then along them to the agent notes.
    await run('pan down to the notes', () => pan(window, 0, NOTES_TOP));
    await run('pan across the notes', () => pan(window, AGENT_NOTES_LEFT + 6 * NOTE_PITCH, 0));
    // Back out to everything: every terminal and note comes back at once.
    await run('zoom out to the overview', () => zoomTo(window, 0.15, centre));
    await run('overview, idle again', () => sleep(5000));

    const result = { size: SIZE, cpuSlowdown: CPU_SLOWDOWN, headed: process.env.AGENT_BOARD_HEADED === '1', appEnv: APP_ENV, phases };
    writeFileSync(test.info().outputPath('render-bench.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.table(phases.map(({ name, frames, p50Ms, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, slowestSnapshotMs, terminals, rendererMb, rendererCpu, daemonCpu, commits, renders }) => ({ name, frames, p50Ms, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, slowestSnapshotMs, terminals, rendererMb, rendererCpu, daemonCpu, commits, renders })));
    console.log(`results in ${test.info().outputPath('render-bench.json')}`);
  } finally {
    // Stopping the daemon (in removeDataDir) ends its shells, the looping ones too.
    await first?.close();
    await app?.close();
    await removeDataDir(dataDir);
  }
});
