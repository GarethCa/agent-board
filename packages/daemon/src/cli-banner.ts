import type {} from './import-meta-glob.ts';

/** brand/cli-banner.txt, inlined at build time like the migrations. */
const [TEMPLATE = ''] = Object.values(
  import.meta.glob<string>('../../../brand/cli-banner.txt', { query: '?raw', import: 'default', eager: true }),
);

/**
 * What `agent-board daemon` prints as it starts: the brand's banner (brand/cli-banner.txt) with the build, the live
 * sessions it picked up and how many agents wait for the user, each phrase in the singular for one.
 */
export function cliBanner({ version, sessions, waiting }: { version: string; sessions: number; waiting: number }): string {
  return TEMPLATE.trimEnd()
    .replace('{version}', version)
    .replace('{sessions} sessions', sessions === 1 ? '1 session' : `${sessions} sessions`)
    .replace('{waiting} agents need', waiting === 1 ? '1 agent needs' : `${waiting} agents need`);
}
