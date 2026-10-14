import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recount } from './counts.ts';
import { commandPlan } from './flow-approvals.ts';
import type { Approvals, ConditionChecker } from './flow-conditions.ts';
import { checkPayloadPath, readPayload, type PayloadRead } from './flow-payloads.ts';
import { keyedQueue } from './keyed-queue.ts';
import { CLIENT_ID, invalidParams, oneOf, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import {
  DEFAULT_PAYLOAD_PATHS,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_DELIVERY_MODES,
  FLOW_EDGE_HISTORY,
  FLOW_EDGE_PAYLOADS,
  FLOW_EDGE_TRIGGERS,
  type DaemonEvent,
  type DaemonMethods,
  type FlowCommandApproval,
  type FlowCondition,
  type FlowConditionCheck,
  type FlowEdge,
  type FlowEdgeEvent,
  type FlowEdgeDeliveryMode,
  type FlowEdgeEventKind,
  type FlowEdgePayload,
  type FlowEdgeTrigger,
  type HeldPayloadStorage,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { RunStart } from './schedules.ts';

type FlowEdgeMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `flowEdge.${string}`>>;

/** At most this many conditions on an edge. */
const MAX_CONDITIONS = 8;
/** How long a condition's command or label may be. */
const MAX_CONDITION_TEXT = 500;

/** What an edge needs of the agent at its start. */
export interface FlowAgent {
  name: string;
  worktree: string;
}

export interface FlowEdgeHostOptions {
  db: DatabaseSync;
  /**
   * Delivers `text`, the payload `name`, from agent `from` to agent `to` as `to`'s next message, `from` handing off
   * meanwhile, unless `to` can't take it now (and why). Relaunches an ended `to`.
   */
  deliver(from: string, to: string, name: string, text: string): Promise<RunStart>;
  /** The agent's final message from the turn it last finished, if it has finished one. */
  finalMessage(sessionId: string): string | undefined;
  /** The agent, if it still exists. */
  agent(sessionId: string): FlowAgent | undefined;
  conditions: ConditionChecker;
  /** Whether a hand-off held or queued keeps a copy of its file, or only its path, read again when it is delivered. */
  heldPayloads(): HeldPayloadStorage;
  /** How often held hand-offs are checked again by themselves; 0 only when told to (`recheck`) or their rules change. */
  recheckMs: number;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

export interface FlowEdgeHost {
  /**
   * The one way a hand-off happens, whatever told the daemon of it: delivers along every auto edge out of the agent,
   * each carrying its own payload as it is now, or holds it there until the edge's conditions pass.
   */
  handOff(sessionId: string): void;
  /** Checks the hand-offs held on the agent's edges again now, as when its pull requests changed. */
  recheck(sessionId: string): void;
  /**
   * Deletes the agent's edges, either way, telling every client: before the agent's own deletion, whose foreign keys
   * would take them without a word.
   */
  dropAgent(sessionId: string): void;
  /** Drops the copies of the files held and queued hand-offs carry: they will be read again when delivered. */
  dropCopies(): void;
  /** Stops checking held hand-offs by itself. */
  stop(): void;
  handlers<Context>(): RpcHandlers<FlowEdgeMethods, Context>;
}

interface FlowEdgeRow {
  id: string;
  from_session_id: string;
  to_session_id: string;
  trigger: FlowEdgeTrigger;
  payload: FlowEdgePayload;
  path: string | null;
  conditions: string;
  approvals: string;
  held_name: string | null;
  held_text: string | null;
  held_since: string | null;
  held_reason: string | null;
  paused: number;
  deliver_as: FlowEdgeDeliveryMode;
  queued_name: string | null;
  queued_text: string | null;
  queued_since: string | null;
  delivered_at: string | null;
  skipped_because: string | null;
  created_at: string;
  updated_at: string;
}

/** A payload read and ready to deliver. */
type Payload = Pick<Extract<PayloadRead, { text: string }>, 'name' | 'text' | 'bytes'>;

/** A size as the history says it: `812 B`, `2.1 KB`. */
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Checks an edge's conditions as a client gave them, tidying their text. Throws `invalidParams` for a bad one. */
function conditionsParam(value: unknown): FlowCondition[] {
  if (!Array.isArray(value)) throw invalidParams('conditions must be a list');
  if (value.length > MAX_CONDITIONS) throw invalidParams(`an edge has at most ${MAX_CONDITIONS} conditions`);
  return value.map((item: unknown): FlowCondition => {
    const fields = paramsObject(item);
    const kind = oneOf(fields, 'kind', FLOW_CONDITION_KINDS);
    if (kind === 'pr-checks') return { kind };
    const name = kind === 'issue-label' ? 'label' : 'command';
    const text = typeof fields[name] === 'string' ? fields[name].trim() : '';
    if (text === '' || text.length > MAX_CONDITION_TEXT) {
      throw invalidParams(`a ${kind} condition needs a ${name} of at most ${MAX_CONDITION_TEXT} characters`);
    }
    return kind === 'issue-label' ? { kind, label: text } : { kind, command: text };
  });
}

/**
 * Flow edges, backed by the `flow_edges` table, and the delivery along them. An edge goes with
 * either agent through its foreign keys, which don't announce it. Every other change, each delivery included, is
 * broadcast to every client. Auto edges never make a loop, so a hand-off can't come back round to the agent that made
 * it. An auto hand-off along an edge with conditions is checked first, and held while any fails: checked again every
 * `recheckMs`, when told to, and when its rules change, and delivered once they all pass. A newer hand-off replaces a
 * held one; Send delivers whatever they say, dropping it. Made manual, an edge drops what it held; paused, it delivers
 * nothing by itself. An edge that queues keeps a delivery its `to` agent can't take now, and tries it again when that
 * agent's turn ends and every `recheckMs`.
 */
export function createFlowEdgeHost(options: FlowEdgeHostOptions): FlowEdgeHost {
  const { db } = options;
  const selectAll = db.prepare('SELECT * FROM flow_edges ORDER BY created_at, rowid');
  const selectOne = db.prepare('SELECT * FROM flow_edges WHERE id = ?');
  const selectPair = db.prepare('SELECT 1 FROM flow_edges WHERE from_session_id = ? AND to_session_id = ?');
  const selectAutoOut = db.prepare("SELECT * FROM flow_edges WHERE from_session_id = ? AND trigger = 'auto' ORDER BY rowid");
  const selectHeld = db.prepare('SELECT * FROM flow_edges WHERE held_since IS NOT NULL ORDER BY rowid');
  const selectHeldOut = db.prepare('SELECT * FROM flow_edges WHERE held_since IS NOT NULL AND from_session_id = ? ORDER BY rowid');
  const selectQueued = db.prepare('SELECT * FROM flow_edges WHERE queued_since IS NOT NULL AND paused = 0 ORDER BY rowid');
  const selectQueuedIn = db.prepare('SELECT * FROM flow_edges WHERE queued_since IS NOT NULL AND paused = 0 AND to_session_id = ? ORDER BY rowid');
  const selectOfAgent = db.prepare('SELECT id FROM flow_edges WHERE from_session_id = ? OR to_session_id = ?');
  const selectAutoEdges = db.prepare("SELECT from_session_id, to_session_id FROM flow_edges WHERE trigger = 'auto'");
  const selectEvents = db.prepare('SELECT at, kind, detail FROM flow_edge_events WHERE edge_id = ? ORDER BY id DESC LIMIT ?');
  const countDeliveries = db.prepare("SELECT count(*) AS n FROM flow_edge_events WHERE edge_id = ? AND kind = 'delivered'");
  const agentExists = db.prepare('SELECT 1 FROM agents WHERE session_id = ?');
  const insert = db.prepare(
    `INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, path, conditions, deliver_as, paused)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRules = db.prepare(
    `UPDATE flow_edges SET trigger = ?, payload = ?, path = ?, conditions = ?, approvals = ?, deliver_as = ?, paused = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const updateApprovals = db.prepare(
    "UPDATE flow_edges SET approvals = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  );
  // A final message is kept anyway (`agents.final_message`); a file's copy is what goes.
  const selectCopies = db.prepare(
    `SELECT id FROM flow_edges WHERE payload != 'final-message' AND (held_text IS NOT NULL OR queued_text IS NOT NULL)`,
  );
  const dropCopy = db.prepare('UPDATE flow_edges SET held_text = NULL, queued_text = NULL WHERE id = ?');
  const updateDelivery = db.prepare(
    `UPDATE flow_edges SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), skipped_because = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const updateHold = db.prepare(
    `UPDATE flow_edges SET held_name = ?, held_text = ?, held_reason = ?,
     held_since = coalesce(held_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const updateHeldReason = db.prepare('UPDATE flow_edges SET held_reason = ? WHERE id = ? AND held_since = ?');
  // Only the hold it was asked about: a hand-off or a Send since may have replaced or dropped it.
  const clearHold = db.prepare(
    'UPDATE flow_edges SET held_name = NULL, held_text = NULL, held_since = NULL, held_reason = NULL WHERE id = ? AND held_since IS ?',
  );
  const updateQueue = db.prepare(
    `UPDATE flow_edges SET queued_name = ?, queued_text = ?,
     queued_since = coalesce(queued_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  // Only the queued delivery it was asked about: one queued since replaces it.
  const clearQueue = db.prepare(
    'UPDATE flow_edges SET queued_name = NULL, queued_text = NULL, queued_since = NULL WHERE id = ? AND queued_since IS ?',
  );
  const insertEvent = db.prepare('INSERT INTO flow_edge_events (edge_id, kind, detail) VALUES (?, ?, ?)');
  const remove = db.prepare('DELETE FROM flow_edges WHERE id = ?');

  /** The edges delivering now, by id, each with how many deliveries along it are on their way. */
  const delivering = new Map<string, number>();
  /** Each edge's conditions' last checks, by id. Only memory holds them. */
  const checks = new Map<string, (FlowConditionCheck | null)[]>();
  /** The edges whose held hand-off is being checked now. */
  const checking = new Set<string>();
  /** Hand-offs and checks along one edge, one at a time. */
  const serially = keyedQueue();

  const conditionsOf = (row: FlowEdgeRow) => JSON.parse(row.conditions) as FlowCondition[];
  const approvalsOf = (row: FlowEdgeRow) => JSON.parse(row.approvals) as Record<string, string>;
  /** The commands the edge's gates and scripts run, each once. */
  const commandsOf = (conditions: readonly FlowCondition[]) => [
    ...new Set(conditions.flatMap((condition) => ('command' in condition ? [condition.command] : []))),
  ];
  /** Whether a hand-off along the edge, held or queued, keeps a copy of what it carries. */
  const keepsCopy = (row: FlowEdgeRow) => row.payload === 'final-message' || options.heldPayloads() === 'copy';
  const toFlowEdge = (row: FlowEdgeRow): FlowEdge => {
    const conditions = conditionsOf(row);
    const checked = checks.get(row.id);
    return {
      id: row.id,
      from: row.from_session_id,
      to: row.to_session_id,
      trigger: row.trigger,
      payload: row.payload,
      path: row.path,
      conditions,
      checks: conditions.map((_, index) => checked?.[index] ?? null),
      held:
        row.held_since === null
          ? null
          : { since: row.held_since, reason: row.held_reason ?? '', name: row.held_name ?? 'payload', copy: row.held_text !== null },
      deliverAs: row.deliver_as,
      queued:
        row.queued_since === null
          ? null
          : { since: row.queued_since, name: row.queued_name ?? 'payload', copy: row.queued_text !== null },
      paused: row.paused === 1,
      lastDelivery:
        row.delivered_at === null ? null : { at: row.delivered_at, delivered: row.skipped_because === null, reason: row.skipped_because },
      history: selectEvents.all(row.id, FLOW_EDGE_HISTORY) as unknown as FlowEdgeEvent[],
      deliveries: (countDeliveries.get(row.id) as { n: number }).n,
      delivering: delivering.has(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const find = (id: string) => selectOne.get(id) as FlowEdgeRow | undefined;
  const get = (id: string): FlowEdge => {
    const row = find(id);
    if (row === undefined) throw invalidParams(`no flow edge ${id}`);
    return toFlowEdge(row);
  };
  const announce = (edge: FlowEdge): FlowEdge => {
    options.broadcast({ type: 'flowEdge.updated', edge });
    return edge;
  };
  /** Tells every client about the edge, if it is still there. */
  const announceId = (id: string) => {
    const row = find(id);
    if (row !== undefined) announce(toFlowEdge(row));
  };
  const record = (id: string, kind: FlowEdgeEventKind, detail: string) => {
    if (find(id) !== undefined) insertEvent.run(id, kind, detail);
  };

  /** Whether an auto edge from `from` to `to` would close a loop: `to` already reaches `from` along auto edges. */
  const closesAutoLoop = (from: string, to: string) => {
    const next = new Map<string, string[]>();
    for (const row of selectAutoEdges.all() as unknown as Pick<FlowEdgeRow, 'from_session_id' | 'to_session_id'>[]) {
      next.set(row.from_session_id, [...(next.get(row.from_session_id) ?? []), row.to_session_id]);
    }
    const seen = new Set<string>();
    const reaching = [to];
    while (reaching.length > 0) {
      const agent = reaching.pop()!;
      if (agent === from) return true;
      if (seen.has(agent)) continue;
      seen.add(agent);
      reaching.push(...(next.get(agent) ?? []));
    }
    return false;
  };
  const refuseAutoLoop = (from: string, to: string) => {
    if (closesAutoLoop(from, to)) {
      throw invalidParams('an auto edge there would close a loop of auto edges, and the agents would answer each other for ever');
    }
  };

  /** What the edge carries from its `from` agent now. */
  const read = async (row: FlowEdgeRow): Promise<PayloadRead> => {
    const agent = options.agent(row.from_session_id);
    if (agent === undefined) return { name: row.held_name ?? 'payload', problem: 'its agent has been deleted' };
    return readPayload({
      payload: row.payload,
      path: row.path,
      worktree: agent.worktree,
      finalMessage: options.finalMessage(row.from_session_id),
    });
  };

  /** Records a delivery that never set out, saying why. */
  const skip = (id: string, reason: string) => {
    options.log(`flow edge ${id} skipped a hand-off: ${reason}`);
    if (updateDelivery.run(reason, id).changes === 0) return;
    record(id, 'skipped', reason);
    announceId(id);
  };

  /** Tries `payload` along the edge to its `to` agent: how it went. */
  const attempt = async (row: FlowEdgeRow, payload: Payload): Promise<RunStart> => {
    recount(delivering, row.id, 1);
    announceId(row.id);
    return options
      .deliver(row.from_session_id, row.to_session_id, payload.name, payload.text)
      .catch((error: Error): RunStart => ({ started: false, reason: `it could not be sent: ${error.message}` }))
      .finally(() => recount(delivering, row.id, -1));
  };

  /**
   * Delivers `payload` along the edge and records how it went. Never throws: a failed delivery is a skipped one. One
   * its `to` agent can't take now is queued instead, on an edge that queues, until that agent's turn ends.
   */
  const deliverAlong = async (row: FlowEdgeRow, payload: Payload): Promise<FlowEdge | undefined> => {
    const result = await attempt(row, payload);
    if (!result.started && result.busy === true && find(row.id)?.deliver_as === 'queue') {
      if (updateQueue.run(payload.name, keepsCopy(row) ? payload.text : null, row.id).changes === 0) return undefined;
      record(row.id, 'queued', result.reason);
      return announce(get(row.id));
    }
    if (!result.started) options.log(`flow edge ${row.id} skipped delivering to ${row.to_session_id}: ${result.reason}`);
    // Either agent may have gone meanwhile, and the edge with it.
    if (updateDelivery.run(result.started ? null : result.reason, row.id).changes === 0) return undefined;
    record(row.id, result.started ? 'delivered' : 'skipped', result.started ? `${payload.name} (${size(payload.bytes)})` : result.reason);
    return announce(get(row.id));
  };

  /** Checks the edge's conditions, keeping how each did: the first that failed, or undefined when all passed. */
  const failing = async (row: FlowEdgeRow): Promise<string | undefined> => {
    const conditions = conditionsOf(row);
    if (conditions.length === 0) return undefined;
    const agent = options.agent(row.from_session_id);
    if (agent === undefined) return 'its agent has been deleted';
    const agentOf = { sessionId: row.from_session_id, worktree: agent.worktree };
    const results = await options.conditions.all(conditions, agentOf, approvalsOf(row) satisfies Approvals);
    // Its conditions or approvals may have changed meanwhile: these checks are of the old ones, so check the new ones.
    const now = find(row.id);
    if (now === undefined) return 'its edge has been deleted';
    if (now.conditions !== row.conditions || now.approvals !== row.approvals) return failing(now);
    checks.set(row.id, results);
    return results.find((result) => !result.passed)?.detail;
  };

  /** What its checks found, without when: a check again that found the same tells no one. */
  const findings = (id: string) => JSON.stringify(checks.get(id)?.map((check) => check && [check.passed, check.detail]));

  /** An auto hand-off along one edge: delivered, or held until its conditions pass. */
  const handOffAlong = (id: string) =>
    serially(id, async () => {
      // Its rules may have changed while an earlier hand-off along it was checked.
      const row = find(id);
      if (row?.trigger !== 'auto') return;
      if (row.paused === 1) return skip(id, 'the edge was paused');
      const payload = await read(row);
      if ('problem' in payload) return skip(id, payload.problem);
      const failed = await failing(row);
      // Its rules may have changed while it was checked (a gate takes minutes): as they are now, not as they were.
      const now = find(id);
      if (now === undefined) return;
      if (now.trigger !== 'auto') return skip(id, 'it was made manual while it was checked');
      if (now.payload !== row.payload || now.path !== row.path) return skip(id, 'its payload changed while it was checked');
      if (failed === undefined && now.paused === 0) {
        // This newer hand-off replaces any held.
        clearHold.run(id, now.held_since);
        await deliverAlong(now, payload);
        return;
      }
      // Paused while it was checked, it waits like one held: checked again once resumed.
      const reason = failed ?? 'the edge was paused while it was checked';
      if (updateHold.run(payload.name, keepsCopy(now) ? payload.text : null, reason, id).changes === 0) return;
      record(id, 'held', reason);
      announceId(id);
    });

  /** A held or queued hand-off's payload: its copy, or with only its path kept, its file as it is now. */
  const kept = async (row: FlowEdgeRow, name: string | null, text: string | null): Promise<Payload | Extract<PayloadRead, { problem: string }>> => {
    if (text !== null) return { name: name ?? 'payload', text, bytes: Buffer.byteLength(text) };
    return read(row);
  };

  /** Checks a held hand-off again, delivering it once its conditions pass. */
  const recheckHeld = (row: FlowEdgeRow) => {
    if (checking.has(row.id)) return;
    checking.add(row.id);
    void serially(row.id, async () => {
      const now = find(row.id);
      // Only an auto edge delivers by itself, and not while paused.
      if (now === undefined || now.held_since === null || now.trigger !== 'auto' || now.paused === 1) return;
      const found = findings(now.id);
      const reason = await failing(now);
      if (reason !== undefined) {
        const changed = reason !== now.held_reason;
        if (changed && updateHeldReason.run(reason, now.id, now.held_since).changes > 0) record(now.id, 'held', reason);
        if (changed || findings(now.id) !== found) announceId(now.id);
        return;
      }
      // Paused or made manual while it was checked: it delivers nothing by itself now.
      const after = find(now.id);
      if (after === undefined || after.trigger !== 'auto' || after.paused === 1) return announceId(now.id);
      // Sent, replaced or dropped meanwhile: that one isn't held any more.
      if (clearHold.run(now.id, now.held_since).changes === 0) return;
      record(now.id, 'released', 'every condition passed');
      const payload = await kept(now, now.held_name, now.held_text);
      if ('problem' in payload) return skip(now.id, payload.problem);
      await deliverAlong(now, payload);
    })
      .catch((error: Error) => options.log(`could not check flow edge ${row.id} again: ${error.message}`))
      .finally(() => checking.delete(row.id));
  };

  /**
   * Tries a queued delivery again: delivered (or skipped for good), or, while its `to` agent still can't take it,
   * left queued without a word.
   */
  const deliverQueued = (row: FlowEdgeRow) =>
    serially(row.id, async () => {
      const now = find(row.id);
      if (now === undefined || now.queued_since === null || now.paused === 1) return;
      const payload = await kept(now, now.queued_name, now.queued_text);
      // Paused, dropped or replaced while its file was read.
      const after = find(now.id);
      if (after === undefined || after.paused === 1 || after.queued_since !== now.queued_since) return;
      if ('problem' in payload) {
        if (clearQueue.run(now.id, now.queued_since).changes > 0) skip(now.id, payload.problem);
        return;
      }
      const result = await attempt(now, payload);
      if (!result.started && result.busy === true) return announceId(now.id);
      if (clearQueue.run(now.id, now.queued_since).changes === 0) return;
      if (updateDelivery.run(result.started ? null : result.reason, now.id).changes === 0) return;
      record(now.id, result.started ? 'delivered' : 'skipped', result.started ? `${payload.name} (${size(payload.bytes)})` : result.reason);
      announceId(now.id);
    }).catch((error: Error) => options.log(`could not deliver along flow edge ${row.id}: ${error.message}`));

  const timer = options.recheckMs > 0 ? setInterval(() => {
    for (const row of selectHeld.all() as unknown as FlowEdgeRow[]) recheckHeld(row);
    for (const row of selectQueued.all() as unknown as FlowEdgeRow[]) void deliverQueued(row);
  }, options.recheckMs) : undefined;
  timer?.unref();

  /** A file payload's path as given, else the one it had if the payload is unchanged, else the payload's default. */
  const pathFor = (payload: FlowEdgePayload, given: unknown, had?: { payload: FlowEdgePayload; path: string | null }) => {
    if (payload === 'final-message') {
      if (given !== undefined) throw invalidParams('a final message carries no file: leave out its path');
      return null;
    }
    if (given !== undefined) {
      if (typeof given !== 'string') throw invalidParams('path must be a string');
      return checkPayloadPath(given);
    }
    return had?.payload === payload ? had.path : DEFAULT_PAYLOAD_PATHS[payload];
  };

  return {
    handOff(sessionId) {
      // Its turn is over: what was queued for it can come now.
      for (const row of selectQueuedIn.all(sessionId) as unknown as FlowEdgeRow[]) void deliverQueued(row);
      for (const row of selectAutoOut.all(sessionId) as unknown as FlowEdgeRow[]) {
        handOffAlong(row.id).catch((error: Error) => options.log(`could not hand off along flow edge ${row.id}: ${error.message}`));
      }
    },

    recheck(sessionId) {
      for (const row of selectHeldOut.all(sessionId) as unknown as FlowEdgeRow[]) recheckHeld(row);
    },

    dropAgent(sessionId) {
      for (const { id } of selectOfAgent.all(sessionId, sessionId) as unknown as Pick<FlowEdgeRow, 'id'>[]) {
        remove.run(id);
        checks.delete(id);
        options.broadcast({ type: 'flowEdge.removed', id });
      }
    },

    dropCopies() {
      for (const { id } of selectCopies.all() as unknown as Pick<FlowEdgeRow, 'id'>[]) {
        dropCopy.run(id);
        announceId(id);
      }
    },

    stop() {
      clearInterval(timer);
    },

    handlers: () => ({
      'flowEdge.list': () => (selectAll.all() as unknown as FlowEdgeRow[]).map(toFlowEdge),
      'flowEdge.create': (params) => {
        const fields = paramsObject(params);
        const from = stringParam(fields, 'from');
        const to = stringParam(fields, 'to');
        const trigger = fields.trigger === undefined ? 'auto' : oneOf(fields, 'trigger', FLOW_EDGE_TRIGGERS);
        const payload = fields.payload === undefined ? 'final-message' : oneOf(fields, 'payload', FLOW_EDGE_PAYLOADS);
        const path = pathFor(payload, fields.path);
        const conditions = fields.conditions === undefined ? [] : conditionsParam(fields.conditions);
        const deliverAs = fields.deliverAs === undefined ? 'message' : oneOf(fields, 'deliverAs', FLOW_EDGE_DELIVERY_MODES);
        const paused = optionalBooleanParam(fields, 'paused') ?? false;
        if (from === to) throw invalidParams('a flow edge can not join an agent to itself');
        for (const end of [from, to]) if (agentExists.get(end) === undefined) throw invalidParams(`no agent ${end}`);
        if (selectPair.get(from, to) !== undefined) throw invalidParams('a flow edge already joins those agents that way');
        if (trigger === 'auto') refuseAutoLoop(from, to);
        const id = fields.id === undefined ? randomUUID() : stringParam(fields, 'id');
        if (!CLIENT_ID.test(id)) throw invalidParams('a flow edge id is letters, digits and -, at most 64');
        if (find(id) !== undefined) throw invalidParams(`flow edge ${id} already exists`);
        insert.run(id, from, to, trigger, payload, path, JSON.stringify(conditions), deliverAs, paused ? 1 : 0);
        return announce(get(id));
      },
      'flowEdge.update': (params) => {
        const fields = paramsObject(params);
        const row = find(stringParam(fields, 'id'));
        if (row === undefined) throw invalidParams(`no flow edge ${String(fields.id)}`);
        const trigger = fields.trigger === undefined ? row.trigger : oneOf(fields, 'trigger', FLOW_EDGE_TRIGGERS);
        const payload = fields.payload === undefined ? row.payload : oneOf(fields, 'payload', FLOW_EDGE_PAYLOADS);
        const path = pathFor(payload, fields.path, row);
        const conditions = fields.conditions === undefined ? row.conditions : JSON.stringify(conditionsParam(fields.conditions));
        // An approval goes with its command: a command typed again, or changed, is approved again.
        const commands = commandsOf(JSON.parse(conditions) as FlowCondition[]);
        const approvals = JSON.stringify(Object.fromEntries(Object.entries(approvalsOf(row)).filter(([command]) => commands.includes(command))));
        const deliverAs = fields.deliverAs === undefined ? row.deliver_as : oneOf(fields, 'deliverAs', FLOW_EDGE_DELIVERY_MODES);
        const paused = optionalBooleanParam(fields, 'paused') ?? row.paused === 1;
        if (trigger === 'auto' && row.trigger !== 'auto') refuseAutoLoop(row.from_session_id, row.to_session_id);
        updateRules.run(trigger, payload, path, conditions, approvals, deliverAs, paused ? 1 : 0, row.id);
        if (conditions !== row.conditions) checks.delete(row.id);
        if (row.held_since !== null) {
          // What it held was read as its old payload, which it no longer carries; and a manual edge delivers only when sent.
          const dropped =
            payload !== row.payload || path !== row.path
              ? 'its payload changed while it was held'
              : trigger !== 'auto'
                ? 'it was made manual while it was held'
                : undefined;
          if (dropped !== undefined) {
            clearHold.run(row.id, row.held_since);
            record(row.id, 'skipped', dropped);
          } else if (conditions !== row.conditions || (row.paused === 1 && !paused)) {
            recheckHeld(find(row.id)!);
          }
        }
        if (row.queued_since !== null) {
          if (deliverAs !== 'queue') {
            clearQueue.run(row.id, row.queued_since);
            record(row.id, 'skipped', 'it was made to deliver as a message while one was queued');
          } else if (row.paused === 1 && !paused) {
            void deliverQueued(find(row.id)!);
          }
        }
        return announce(get(row.id));
      },
      'flowEdge.delete': (params) => {
        const id = stringParam(paramsObject(params), 'id');
        if (remove.run(id).changes === 0) throw invalidParams(`no flow edge ${id}`);
        checks.delete(id);
        options.broadcast({ type: 'flowEdge.removed', id });
        return null;
      },
      'flowEdge.send': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const payload = await read(row);
        if ('problem' in payload) throw invalidParams(payload.problem);
        if (row.held_since !== null && clearHold.run(id, row.held_since).changes > 0) {
          record(id, 'released', 'sent by hand');
        }
        // A newer delivery replaces the one queued.
        clearQueue.run(id, row.queued_since);
        const sent = await deliverAlong(row, payload);
        if (sent === undefined) throw invalidParams(`flow edge ${id} went while it was being sent`);
        return sent;
      },
      'flowEdge.preview': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const payload = await read(row);
        return 'problem' in payload ? payload : { name: payload.name, text: payload.shown, bytes: payload.bytes };
      },
      'flowEdge.commands': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const agent = options.agent(row.from_session_id);
        if (agent === undefined) throw invalidParams(`flow edge ${id}'s agent has been deleted`);
        const approvals = approvalsOf(row);
        return Promise.all(
          commandsOf(conditionsOf(row)).map(async (command): Promise<FlowCommandApproval> => {
            const plan = await commandPlan(command, agent.worktree);
            const approved = Object.hasOwn(approvals, command) ? approvals[command] : undefined;
            return { ...plan, approval: approved === undefined ? 'unapproved' : approved === plan.fingerprint ? 'approved' : 'changed' };
          }),
        );
      },
      'flowEdge.approve': async (params) => {
        const fields = paramsObject(params);
        const id = stringParam(fields, 'id');
        const command = stringParam(fields, 'command');
        const fingerprint = stringParam(fields, 'fingerprint');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        if (!commandsOf(conditionsOf(row)).includes(command)) throw invalidParams(`flow edge ${id} runs no ${command}`);
        const agent = options.agent(row.from_session_id);
        if (agent === undefined) throw invalidParams(`flow edge ${id}'s agent has been deleted`);
        const plan = await commandPlan(command, agent.worktree);
        if (plan.fingerprint !== fingerprint) throw invalidParams(`what ${command} runs has changed since you looked at it: look again`);
        // Read again: its rules may have changed while the plan was read.
        const now = find(id);
        if (now === undefined || !commandsOf(conditionsOf(now)).includes(command)) throw invalidParams(`flow edge ${id} runs no ${command} any more`);
        updateApprovals.run(JSON.stringify({ ...approvalsOf(now), [command]: fingerprint }), id);
        record(id, 'approved', command);
        const edge = announce(get(id));
        if (now.held_since !== null) recheckHeld(find(id)!);
        return edge;
      },
      'flowEdge.drop': (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const held = row.held_since !== null && clearHold.run(id, row.held_since).changes > 0;
        const queued = row.queued_since !== null && clearQueue.run(id, row.queued_since).changes > 0;
        if (held || queued) record(id, 'skipped', `${held ? row.held_name : row.queued_name} was dropped by you`);
        return announce(get(id));
      },
    }),
  };
}
