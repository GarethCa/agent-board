// Prints electron-builder's target flags for `pnpm package` on this machine (apps/desktop/package.json): on Linux
// without apt, only the tar.gz. Node built-ins only, as for the rest of the install step.
import { builderTargetArgs, hasApt } from './linux-install.ts';

console.log(builderTargetArgs(process.platform, process.platform === 'linux' && hasApt()).join(' '));
