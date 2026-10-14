/** Vitest globalSetup: tripwires first on PATH for every worker, and git kept off the dev repo; fail the run if either was hit. */
import { gitGuardGlobalSetup } from '../git-guard.ts';
import { harnessGuardGlobalSetup } from '../guard.ts';

export default function globalSetup(): () => void {
  const teardownHarness = harnessGuardGlobalSetup();
  const teardownGit = gitGuardGlobalSetup();
  return () => {
    try {
      teardownGit();
    } finally {
      teardownHarness();
    }
  };
}
