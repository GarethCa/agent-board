// Quitting the app and waiting for it to go, shared by the scripts that replace the installed app.

/** The app's lifecycle on this machine: a seam, so tests can drive it. */
export interface AppControl {
  running(): boolean;
  quit(): void;
  sleep(ms: number): Promise<void>;
}

/** How long the app gets to quit. */
const QUIT_TIMEOUT_MS = 30_000;

/** Quits the app if it is running, and waits for it to go. Its daemon keeps running, and its sessions with it. */
export async function quitAndWait(app: AppControl, log: (message: string) => void): Promise<void> {
  if (!app.running()) return;
  log('Quitting agent-board');
  app.quit();
  for (let waited = 0; app.running(); waited += 200) {
    if (waited >= QUIT_TIMEOUT_MS) throw new Error('agent-board did not quit; quit it yourself and run this again');
    await app.sleep(200);
  }
}
