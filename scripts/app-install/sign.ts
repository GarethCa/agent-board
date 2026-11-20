// A step of `pnpm package` on macOS, after electron-builder: signs the built app with the local signing identity when
// this Mac has one (`pnpm signing:setup`), or keeps the ad hoc signature and says how to set one up. Elsewhere it does
// nothing. See scripts/app-install/local-signing.ts.
import { resolve } from 'node:path';
import { packagedApp } from '../../apps/desktop/e2e/packaged-app.ts';
import { signApp } from './local-signing.ts';

if (process.platform === 'darwin') {
  try {
    signApp(packagedApp(resolve(import.meta.dirname, '../../apps/desktop')), (message) => console.log(`package: ${message}`));
  } catch (error) {
    console.error(`package: ${(error as Error).message}`);
    process.exit(1);
  }
}
