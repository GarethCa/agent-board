import { execFileSync } from 'node:child_process';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { BuildInfo } from '@agent-board/daemon/protocol';

/**
 * The commit being built, with `-dirty` when tracked files have changes, so a build names what it was built from.
 * Untracked files don't count: Vite writes one beside this config while it loads it.
 */
function buildInfo(): BuildInfo {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  try {
    const [sha = 'unknown', date = ''] = git('log', '-1', '--format=%h%n%cI').split('\n');
    return { sha: git('status', '--porcelain', '--untracked-files=no') === '' ? sha : `${sha}-dirty`, date };
  } catch {
    return { sha: 'unknown', date: '' };
  }
}

export default defineConfig({
  main: {
    // The app and the daemon it starts both report this build (src/main/build.ts).
    define: { __AGENT_BOARD_BUILD__: JSON.stringify(buildInfo()) },
    build: {
      rollupOptions: {
        // `daemon` is `agent-board daemon`, run by the same Electron binary as Node (ADR-0002).
        input: { index: 'src/main/index.ts', daemon: 'src/main/daemon.ts' },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot be ES modules.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
