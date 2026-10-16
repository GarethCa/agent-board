import { describe, expect, it } from 'vitest';
import { parsePs } from '../processes.ts';
import { goneRuns, isVitestProcess, staleRunProcesses, type RunRecord } from './reap.ts';

const node = '/usr/local/bin/node';
const main = (root: string) => `node ${root}/node_modules/.bin/../vitest/vitest.mjs run`;
const fork = (root: string) =>
  `${node} --require ${root}/node_modules/.pnpm/vitest@5.0.3/node_modules/vitest/suppress-warnings.cjs --conditions node ${root}/node_modules/.pnpm/vitest@5.0.3/node_modules/vitest/dist/workers/forks.js`;

describe('isVitestProcess', () => {
  it("matches node running this worktree's Vitest CLI or fork entry", () => {
    expect(isVitestProcess(main('/wt/a'), '/wt/a')).toBe(true);
    expect(isVitestProcess(`node /wt/a/node_modules/.pnpm/vitest@5.0.3/node_modules/vitest/vitest.mjs run x`, '/wt/a')).toBe(true);
    expect(isVitestProcess(fork('/wt/a'), '/wt/a')).toBe(true);
  });

  it('never matches a process that only mentions those paths', () => {
    for (const command of [
      `/Users/me/.local/bin/claude --print review ${fork('/wt/a')}`,
      `claude "ps shows node ${main('/wt/a')}"`,
      'less /wt/a/node_modules/.vite/vitest/results.json',
      `/bin/zsh -c tail -f /wt/a/node_modules/.bin/../vitest/vitest.mjs`,
      `${node} /wt/a/scripts/other.ts /wt/a/node_modules/.bin/../vitest/vitest.mjs.bak`,
      main('/wt/b'),
      fork('/wt/a-2'),
      `${node}-gyp ${main('/wt/a').slice(5)}`,
    ]) expect(isVitestProcess(command, '/wt/a'), command).toBe(false);
  });
});

describe('staleRunProcesses', () => {
  const T = 'Fri 16 Oct 00:00:00 2026';
  const listing = parsePs([
    // A run whose shell was killed: its main orphaned, with a fork.
    `  100     1 ${main('/wt/a')}`,
    `  101   100 ${fork('/wt/a')}`,
    // A run whose main was killed: its fork orphaned.
    `  202     1 ${fork('/wt/a')}`,
    // A live run, in the same process group as the first.
    `  300    50 ${main('/wt/a')}`,
    `  301   300 ${fork('/wt/a')}`,
    // A live run started through \`pnpm exec\`, whose main names Vitest by a relative path.
    `  310    51 node ./node_modules/.bin/../vitest/vitest.mjs run`,
    `  311   310 ${fork('/wt/a')}`,
    // Orphans in the first run's group that are not Vitest, though their command lines name its paths.
    `  400     1 /Users/me/.local/bin/claude --print ${fork('/wt/a')}`,
    `  401     1 less /wt/a/node_modules/.vite/vitest/results.json`,
    // An orphaned fork of an unregistered run.
    `  500     1 ${fork('/wt/a')}`,
    // Another worktree's orphaned run.
    `  600     1 ${main('/wt/b')}`,
    // A registered run's pid, since taken by a live run started later in the same group, with its fork.
    `  700    52 ${main('/wt/a')}`,
    `  701   700 ${fork('/wt/a')}`,
  ].join('\n'));
  const details = new Map(
    [[100, 7], [101, 7], [202, 8], [300, 7], [301, 7], [310, 7], [311, 7], [400, 7], [401, 7], [500, 9], [600, 10], [700, 11], [701, 11]].map(
      ([pid, pgid]) => [pid!, { pgid: pgid!, started: pid === 700 || pid === 701 ? 'Fri 16 Oct 09:00:00 2026' : T }],
    ),
  );
  const runs: RunRecord[] = [
    { root: '/wt/a', pid: 100, pgid: 7, started: T },
    { root: '/wt/a', pid: 200, pgid: 8, started: T },
    { root: '/wt/a', pid: 300, pgid: 7, started: T },
    { root: '/wt/a', pid: 310, pgid: 7, started: T },
    { root: '/wt/b', pid: 600, pgid: 10, started: T },
    { root: '/wt/a', pid: 700, pgid: 11, started: T },
  ];
  const pids = (found: { pid: number }[]) => found.map((p) => p.pid);

  it("finds only the Vitest processes of this worktree's registered runs whose starter or main is gone", () => {
    expect(pids(staleRunProcesses(listing, details, runs, '/wt/a', 999))).toEqual([100, 101, 202]);
  });

  it('leaves a live run alone however its main names Vitest, and a run that took a gone run\'s pid', () => {
    const found = pids(staleRunProcesses(listing, details, runs, '/wt/a', 999));
    for (const live of [300, 301, 310, 311, 700, 701]) expect(found).not.toContain(live);
  });

  it('never picks the reaping process or anything above it', () => {
    const nested = parsePs([...listing.map((p) => `${p.pid} ${p.ppid} ${p.command}`), `  800   101 ${main('/wt/a')}`].join('\n'));
    const withSelf = new Map([...details, [800, { pgid: 7, started: T }]]);
    expect(pids(staleRunProcesses(nested, withSelf, runs, '/wt/a', 800))).toEqual([202]);
  });
});

describe('goneRuns', () => {
  it('lists the records, from any worktree, whose main process has exited or whose pid now belongs to another', () => {
    const details = new Map([[1, { pgid: 1, started: 'a' }], [2, { pgid: 2, started: 'later' }]]);
    const runs: RunRecord[] = [
      { root: '/wt/a', pid: 1, pgid: 1, started: 'a' },
      { root: '/wt/a', pid: 2, pgid: 2, started: 'b' },
      { root: '/wt/gone', pid: 3, pgid: 3, started: 'c' },
    ];
    expect(goneRuns(runs, details).map((r) => r.pid)).toEqual([2, 3]);
  });
});
