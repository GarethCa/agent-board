import { recount } from './counts.ts';
import { handoffLine } from './handoff-text.ts';
import { invalidParams } from './params.ts';
import type { Agent } from './protocol.ts';
import type { RunStart } from './schedules.ts';
import { answerInput, oneLine } from './terminal-input.ts';

/** How long an answer's text gets to land at the prompt before it is submitted, so it isn't taken as a pasted line. */
const ANSWER_SUBMIT_DELAY_MS = 50;

/** What delivering to an agent reads of its row. */
export interface DeliveryRow {
  name: string;
  ended_at: string | null;
  /** The harness's own name for its conversation: Codex's, which `codex resume` needs. */
  harness_session_id: string | null;
}

interface DeliveryOptions<Row extends DeliveryRow> {
  /** Writes `data` to the agent's terminal. */
  write(sessionId: string, data: string): void;
  getRow(sessionId: string): Row | undefined;
  /** The agent, or an invalid-params error if there is none. */
  requireAgent(sessionId: string): Pick<Agent, 'name' | 'endedAt' | 'state'>;
  /** Why a run can't start in the live agent now, or undefined if it can (`evenAsking` as for a hand-off). */
  whyNotReady(row: Row, evenAsking?: boolean): string | undefined;
  /** Relaunches the ended agent with `prompt` as its first message, carrying on Codex conversation `codexSessionId`. */
  relaunch(row: Row, prompt: string | undefined, why: string, codexSessionId?: string | null): RunStart;
  /** Tells every client the agent changed. */
  announce(sessionId: string): void;
  log(message: string): void;
}

/**
 * What is typed at agents' prompts: the user's answers, scheduled runs and other agents' hand-offs, one line after
 * another per agent; an ended agent is relaunched with it instead. Counts the hand-offs each agent has still landing.
 */
export function createDeliveries<Row extends DeliveryRow>(options: DeliveryOptions<Row>) {
  const { getRow, requireAgent, whyNotReady, relaunch, announce } = options;
  /** Per agent handing off, how many of its deliveries are still landing: it shows `handing-off` until none are. */
  const handingOff = new Map<string, number>();
  /** Per agent, the answer being typed into its terminal, so the next waits for it. */
  const answering = new Map<string, Promise<void>>();

  /** Types `text` at the agent's prompt as one line and submits it, as `typeInput` does. */
  const typeLine = (sessionId: string, text: string) => typeInput(sessionId, oneLine(text));

  /**
   * Writes `line` at the agent's prompt, after any line still being typed to it (two typed at once would run
   * together), and submits it once it has landed, so it isn't taken as a pasted line.
   */
  const typeInput = async (sessionId: string, line: string) => {
    const typed = (answering.get(sessionId) ?? Promise.resolve()).then(async () => {
      options.write(sessionId, line);
      await new Promise((resolve) => setTimeout(resolve, ANSWER_SUBMIT_DELAY_MS));
      options.write(sessionId, '\r');
    });
    answering.set(sessionId, typed);
    try {
      await typed;
    } finally {
      if (answering.get(sessionId) === typed) answering.delete(sessionId);
    }
  };

  return {
    /** Whether the agent has a hand-off still landing. */
    isHandingOff: (sessionId: string) => handingOff.has(sessionId),

    /** Forgets the deleted agent's hand-offs still landing. */
    forget(sessionId: string) {
      handingOff.delete(sessionId);
    },

    async answer(sessionId: string, text: string, paste = false) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
      // Its state says so while any permission prompt, its own or a subagent's, is pending.
      if (agent.state === 'needs-permission') throw invalidParams(`${agent.name} needs permission first`);
      if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
      await typeInput(sessionId, answerInput(text, paste));
    },

    runScheduled(sessionId: string, prompt: string): RunStart {
      const row = getRow(sessionId);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (row.ended_at !== null) return relaunch(row, prompt, 'for its scheduled run');
      const reason = whyNotReady(row);
      if (reason !== undefined) return { started: false, reason };
      typeLine(sessionId, prompt).catch((error: Error) => options.log(`could not start a run of ${sessionId}: ${error.message}`));
      return { started: true };
    },

    async deliver(from: string, to: string, name: string, text: string): Promise<RunStart> {
      const row = getRow(to);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (oneLine(text) === '') return { started: false, reason: 'there was nothing to send' };
      const reason = row.ended_at === null ? whyNotReady(row, true) : undefined;
      if (reason !== undefined) return { started: false, reason, busy: true };
      const line = handoffLine(getRow(from)?.name ?? 'another agent', name, text);
      recount(handingOff, from, 1);
      announce(from);
      try {
        if (row.ended_at !== null) return relaunch(row, line, `for a hand-off from ${from}`, row.harness_session_id);
        await typeLine(to, line);
        return { started: true };
      } finally {
        // Deleting `from` meanwhile forgot its count.
        recount(handingOff, from, -1);
        announce(from);
      }
    },
  };
}
