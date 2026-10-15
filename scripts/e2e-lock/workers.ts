/** Playwright workers when `AGENT_BOARD_E2E_WORKERS` is unset: 3, or 2 when the machine is already busy (the one-minute load average above one per core). */
const DEFAULT_WORKERS = 3;
const BUSY_WORKERS = 2;

export function defaultWorkers(loadAverage: number, cores: number): number {
  return loadAverage > cores ? BUSY_WORKERS : DEFAULT_WORKERS;
}
