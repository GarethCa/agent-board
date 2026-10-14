// Tests must never call a real tracker: any request to one fails the test. Providers take a replaying `fetch`, or a
// fake `gh`, instead.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll } from 'vitest';

const TRACKER_HOSTS = ['api.linear.app', 'api.github.com'];
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (TRACKER_HOSTS.includes(url.hostname)) {
    return Promise.reject(new Error(`tests must not call ${url.hostname}: use recorded HTTP fixtures`));
  }
  return realFetch(input, init);
};

// A `gh` tripwire first on PATH: anything that runs `gh` from PATH, rather than the fake (createFakeGitHub), fails
// with exit 127, and the test file fails at the end even if the caller swallowed the error.
const tripwireDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-board-gh-guard-')));
const hits = join(tripwireDir, 'hits.log');
writeFileSync(hits, '');
writeFileSync(
  join(tripwireDir, 'gh'),
  `#!/bin/sh\necho "gh $*" >> '${hits}'\necho "agent-board test guard: refused to run the real gh; use createFakeGitHub()" >&2\nexit 127\n`,
);
chmodSync(join(tripwireDir, 'gh'), 0o755);
process.env.PATH = [tripwireDir, process.env.PATH].filter(Boolean).join(delimiter);
/** The tripwire's log, for the test that trips it on purpose. */
process.env.AGENT_BOARD_GH_GUARD_HITS = hits;

afterAll(() => {
  const found = readFileSync(hits, 'utf8').split('\n').filter(Boolean);
  rmSync(tripwireDir, { recursive: true, force: true });
  if (found.length > 0) throw new Error(`tests tried to run the real gh:\n  ${found.join('\n  ')}`);
});
