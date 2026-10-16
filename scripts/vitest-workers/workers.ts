export interface WorkerInputs {
  cores: number;
  /** One-minute load average; NaN when unknown. */
  load: number;
  /** Processes the user already runs, and the per-user limit; null when unknown. */
  processCount: number | null;
  processLimit: number | null;
  /** AGENT_BOARD_VITEST_WORKERS: a positive integer caps both projects at that many. */
  override: string | undefined;
}

export interface WorkerCounts {
  unit: number;
  processes: number;
  why: string;
}

/** The `processes` project's cap: each of its workers runs a daemon, fake harnesses and git. */
const PROCESSES_CAP = 3;
/**
 * Processes one `processes` worker can have alive at once, with headroom: a daemon, a few fake harnesses, git and the
 * hook forwarders it spawns (observed at roughly 100-150). Keeps the user under the limit.
 */
const PROCESSES_PER_WORKER = 150;

const clamp = (n: number, max: number): number => (Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1);

/** How many Vitest workers each project may use, from the cores, the load average and the room left under the per-user process limit. */
export function chooseWorkers(input: WorkerInputs): WorkerCounts {
  let note = '';
  if (input.override !== undefined) {
    const forced = Number(input.override);
    if (Number.isInteger(forced) && forced > 0) return { unit: forced, processes: forced, why: 'AGENT_BOARD_VITEST_WORKERS' };
    note = `, ignored AGENT_BOARD_VITEST_WORKERS="${input.override}"`;
  }
  const load = Number.isFinite(input.load) ? input.load : 0;
  const idle = input.cores - load;
  let unit = clamp(Math.min(input.cores - 1, idle), input.cores - 1);
  let processes = clamp(Math.min(PROCESSES_CAP, idle / 2), PROCESSES_CAP);
  let why = `${input.cores} cores, load ${load.toFixed(1)}`;
  if (input.processCount !== null && input.processLimit !== null) {
    const room = Math.floor((input.processLimit - input.processCount) / PROCESSES_PER_WORKER);
    const cut = room < processes || room + 1 < unit;
    processes = clamp(Math.min(processes, room), PROCESSES_CAP);
    unit = clamp(Math.min(unit, room + 1), unit);
    if (cut) why += `, ${input.processCount}/${input.processLimit} processes`;
  }
  return { unit, processes, why: why + note };
}
