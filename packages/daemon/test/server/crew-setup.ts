// A daemon for crew server tests: its agents on the fake harness, GitHub a fake `gh`, and a zone of a repo whose
// origin is acme/web to `gh`, pushing to a bare repo of the test's.
import { execFileSync } from 'node:child_process';
import { vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import type { Crew } from '../../src/protocol.ts';
import type { FakeClock } from '../fake-clock.ts';
import { connectTestClient, git, pushesTo, startTestDaemon, tempDataDir, tempRepo } from '../helpers.ts';

/** A repo whose origin is GitHub's acme/web to `gh`, and pushes to a bare repo of the test's. */
export function repoWithOrigin() {
  const repo = tempRepo();
  const origin = tempDataDir();
  execFileSync('git', ['init', '--quiet', '--bare', origin]);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
  pushesTo(origin, 'https://github.com/acme/web.git');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  return { repo, origin };
}

/** The daemon, its client and its zone; on `clock` if given. */
export async function crewDaemon(clock?: FakeClock) {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web', description: null }] });
  const { repo, origin } = repoWithOrigin();
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    gh: github.gh,
    pullRequestPollMs: 100,
    ...(clock === undefined ? {} : { clock }),
    // Repeating, so a maker sent back hands off again as it did at first.
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, repeat: true }),
  });
  const client = await connectTestClient(daemon);
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
  return { github, repo, origin, client, zone, daemon };
}

export type CrewSetup = Awaited<ReturnType<typeof crewDaemon>>;

/** The crew once `until` holds of it. */
export async function crewWhen(client: CrewSetup['client'], crewId: string, until: (crew: Crew) => boolean) {
  return vi.waitFor(
    async () => {
      const [crew] = (await client.call('orchestrator.crews', { crewId })) as Crew[];
      if (crew === undefined || !until(crew)) throw new Error(`not yet: ${JSON.stringify(crew)}`);
      return crew;
    },
    { timeout: 30_000, interval: 100 },
  );
}
