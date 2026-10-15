// A merge gate's output (ADR-0013): the gate command prints what it is doing as it goes, and lines of the form
// `::gate …` say which of its steps run, and how each ended. Anything else is output. A command that prints no markers
// is one step, named after itself. Pure, with no Node imports, so the app can read a run's steps as the daemon does.

/** How one of a gate's steps is doing. */
export type GateStepStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'stopped';

export interface GateStep {
  name: string;
  status: GateStepStatus;
  /** When it started; null while it waits. */
  startedAt: string | null;
  /** When it ended; null until it has. */
  endedAt: string | null;
  /** The file its output goes to, when the gate names one (`log=`), which the daemon follows into the run's own log. */
  log?: string;
}

/** What one line of a gate's output says. */
export type GateEvent =
  /** `::gate steps <name>…`: the steps it will run, in order, all waiting. */
  | { type: 'steps'; names: string[] }
  /** `::gate start <name> [log=<absolute path>]`. */
  | { type: 'start'; name: string; log?: string }
  /** `::gate end <name> pass|fail`. */
  | { type: 'end'; name: string; passed: boolean }
  | { type: 'line'; text: string };

/** A step's name: one word of letters, digits, `.`, `:`, `_` and `-`. */
const STEP_NAME = /^[\w.:-]+$/;

const MARKER = /^::gate (steps|start|end)((?: +\S+)*) *$/;

/** What the line says: a marker, or else (a marker it can't read too) a line of output. */
export function parseGateLine(line: string): GateEvent {
  const text: GateEvent = { type: 'line', text: line };
  const marker = MARKER.exec(line);
  if (marker === null) return text;
  const words = marker[2]!.trim().split(/ +/).filter(Boolean);
  if (marker[1] === 'steps') return words.length > 0 && words.every((word) => STEP_NAME.test(word)) ? { type: 'steps', names: words } : text;
  const [name, arg, ...rest] = words;
  if (name === undefined || !STEP_NAME.test(name) || rest.length > 0) return text;
  if (marker[1] === 'end') return arg === 'pass' || arg === 'fail' ? { type: 'end', name, passed: arg === 'pass' } : text;
  if (arg === undefined) return { type: 'start', name };
  const log = /^log=(\/.+)$/.exec(arg)?.[1];
  return log === undefined ? text : { type: 'start', name, log };
}

/** The steps once `event` has happened, `at` (an ISO time); a step not yet heard of joins at the end. */
export function applyGateEvent(steps: readonly GateStep[], event: GateEvent, at: string): GateStep[] {
  const named = (name: string): GateStep[] => (steps.some((step) => step.name === name) ? [...steps] : [...steps, { name, status: 'waiting', startedAt: null, endedAt: null }]);
  switch (event.type) {
    case 'line':
      return [...steps];
    case 'steps':
      return event.names.reduce<GateStep[]>((all, name) => (all.some((step) => step.name === name) ? all : [...all, { name, status: 'waiting', startedAt: null, endedAt: null }]), [...steps]);
    case 'start':
      return named(event.name).map((step) =>
        step.name === event.name ? { name: step.name, status: 'running', startedAt: at, endedAt: null, ...(event.log === undefined ? {} : { log: event.log }) } : step,
      );
    case 'end':
      return named(event.name).map((step) => (step.name === event.name ? { ...step, status: event.passed ? 'passed' : 'failed', startedAt: step.startedAt ?? at, endedAt: at } : step));
  }
}

/** The step a line of output belongs to: the one running, if exactly one is; else none (the run's own). */
export function lineStep(steps: readonly GateStep[]): string | undefined {
  const running = steps.filter((step) => step.status === 'running');
  return running.length === 1 ? running[0]!.name : undefined;
}

/**
 * The steps once the command has ended: one named after the command if it marked none, those still running ended as the
 * whole gate did (stopped, if it was), and those that never started left waiting.
 */
export function finishGateSteps(
  steps: readonly GateStep[],
  run: { command: string; outcome: 'passed' | 'failed' | 'stopped'; startedAt: string; endedAt: string },
): GateStep[] {
  const status: GateStepStatus = run.outcome;
  if (steps.length === 0) return [{ name: run.command, status, startedAt: run.startedAt, endedAt: run.endedAt }];
  return steps.map((step) => (step.status === 'running' ? { ...step, status, endedAt: run.endedAt } : step));
}
