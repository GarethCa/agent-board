// `pnpm signing:setup`: makes the certificate `pnpm package` signs the macOS app with, once per Mac, so macOS keeps
// its folder and app-data answers across updates (docs/macos-folder-prompts.md).
import { setUpLocalSigning } from './local-signing.ts';

if (process.platform !== 'darwin') {
  console.error('signing:setup is for macOS: other builds are not signed.');
  process.exit(1);
}
try {
  setUpLocalSigning();
} catch (error) {
  console.error(`signing:setup: ${(error as Error).message}`);
  process.exit(1);
}
