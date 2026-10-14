import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_NAME = 'agent-board.app';

/**
 * The .app `pnpm package` left in `<desktopDir>/dist`: `mac-arm64/` or `mac/`, by architecture. Packaging empties
 * dist/ first, so there is exactly one; more means a stale build, and this throws rather than guess.
 */
export function packagedApp(desktopDir: string): string {
  const dist = join(desktopDir, 'dist');
  const apps = existsSync(dist)
    ? readdirSync(dist)
        .filter((dir) => dir.startsWith('mac'))
        .map((dir) => join(dist, dir, APP_NAME))
        .filter((path) => existsSync(path))
    : [];
  if (apps.length !== 1) {
    throw new Error(
      apps.length === 0
        ? `no ${APP_NAME} in ${dist}: run \`pnpm package\` first`
        : `more than one ${APP_NAME} in ${dist} (${apps.join(', ')}): run \`pnpm package\` again`,
    );
  }
  return apps[0]!;
}
