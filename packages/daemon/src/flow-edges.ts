import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recount } from './counts.ts';
import { commandPlan } from './flow-approvals.ts';
import type { Approvals, ConditionChecker } from './flow-conditions.ts';
import { checkPayloadPath, MAX_PAYLOAD_BYTES, payloadName, readPayload, type PayloadRead } from './flow-payloads.ts';
import { keyedQueue } from './keyed-queue.ts';
import { CLIENT_ID, invalidParams, oneOf, optionalBooleanParam, paramsObject, pointsParam, stringParam } from './params.ts';
import {
  FLOW_EDGE_SIDES,
  CONNECTOR_STYLES,
  DEFAULT_FLOW_EDGE_SHAPE,
  type FlowEdgeSide,
  type ConnectorStyle,
  type FlowEdgeShape,
  DEFAULT_PAYLOAD_PATHS,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_DELIVERY_MODES,
  FLOW_EDGE_HISTORY,
  FLOW_EDGE_PAYLOADS,
  FLOW_EDGE_SHAPE_KEYS,
  FLOW_EDGE_TRIGGERS,
  type DaemonEvent,
  type DaemonMethods,
  type FlowCommandApproval,
  type FlowCondition,
  type FlowConditionCheck,
  type FlowDeliveredPayload,
  type FlowEdge,
  type FlowEdgeEvent,
  type FlowEdgeDeliveryMode,
  type FlowEdgeEventKind,
  type FlowEdgePayload,
  type FlowEdgeTrigger,
  type HandoffOutcome,
  type HandoffPayload,
  type HeldPayloadStorage,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { RunStart } from './schedules.ts';

type FlowEdgeMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `flowEdge.${string}`>>;

/** At most this many conditions on an edge. */
const MAX_CONDITIONS = 8;
/** How long a condition's command or label may be. */
const MAX_CONDITION_TEXT = 500;
/**
 * How long an explicit hand-off waits for each edge to deliver, hold or skip before it answers `checking`: well under
 * the 60 s Codex gives an MCP tool call, since a gate can take minutes.
 */
const HANDOFF_ANSWER_MS = 5_000;

/** What an edge needs of the agent at its start. */
export interface FlowAgent {
  name: string;
  worktree: string;
  /** When its session ended; null while it runs. */
  endedAt: string | null;
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
   * A hand-off inferred from the agent's turn ending (its Stop): delivers along every auto edge out of the agent, each
   * carrying its own payload as it is now, or holds it there until the edge's conditions pass. An edge it handed off
   * along explicitly this turn (`handOffExplicitly`) is left out: that was this turn's hand-off along it.
   */
  handOff(sessionId: string): void;
  /**
   * The agent hands off explicitly (`board.handoff`): along each of its outgoing edges, or with `to` its edge to
   * that agent alone, as its auto hand-off would go, each edge taking the part of `payload` that matches what it
   * carries. A manual edge is left for the user. Resolves with how each went, or `checking` for one still being checked
   * after `HANDOFF_ANSWER_MS`, whose outcome `onSettled` hears once it has one. Resolves with none when no edge leaves
   * it and it names no `to`. Throws `invalidParams` for no edge to `to`, or a bad payload. An edge it hands off along counts as this turn's until its next turn boundary (`turnBoundary`).
   * With `reach`, a `to` it has no edge to (which `reach` throws for unless the agent may hand to it) gets a one-off
   * edge, manual and made by the agent, delivered along at once; named again, it goes along that edge.
   */
  handOffExplicitly(
    sessionId: string,
    payload: HandoffPayload,
    to?: string,
    onSettled?: (outcome: HandoffOutcome) => void,
    reach?: (to: string) => void,
  ): Promise<HandoffOutcome[]>;
  /**
   * The agent's turn began, or ended without a `Stop`: what it handed off explicitly before belongs to no turn whose
   * `Stop` is still to come.
   */
  turnBoundary(sessionId: string): void;
  /** Makes an edge, as `flowEdge.create` does, marked as made by `madeBy` (an orchestrator) if given. */
  create(params: unknown, madeBy?: string): FlowEdge;
  /**
   * Joins `from` to `to` with a manual edge carrying `from`'s final message, marked as made by `madeBy`, unless an edge
   * already joins them that way, whoever made it. Returns the edge made, or undefined when there was one.
   */
  link(from: string, to: string, madeBy?: string): FlowEdge | undefined;
  /** The edge, if there is one. */
  get(id: string): FlowEdge | undefined;
  /** Deletes the edge, telling every client. Throws `invalidParams` for an unknown edge. */
  remove(id: string): void;
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
  made_by: string | null;
  one_off: number;
  one_off_name: string | null;
  one_off_text: string | null;
  from_side: FlowEdgeSide;
  to_side: FlowEdgeSide;
  style: ConnectorStyle;
  points: string;
  created_at: string;
  updated_at: string;
}

/** A payload read and ready to deliver. */
type Payload = Pick<Extract<PayloadRead, { text: string }>, 'name' | 'text' | 'bytes'>;
/** A payload, or why it can't be had. */
type PayloadOrProblem = Payload | Extract<PayloadRead, { problem: string }>;
/** How a hand-off went along one edge, without which edge. */
type Outcome = Pick<HandoffOutcome, 'outcome' | 'name' | 'reason'>;

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
 * An approval as an edge keeps it: what the command ran when approved (`commandPlan`'s fingerprint), bound to the sender
 * session and worktree it was approved for; or, kept before an edge's sender could change, the fingerprint alone.
 */
type KeptApproval = string | { fingerprint: string; sessionId: string; worktree: string };

const RULE_FIELDS = ['trigger', 'payload', 'path', 'conditions', 'deliverAs', 'paused'] as const;

/** An edge's shape from a client's params, each part not given as it is in `had`. */
function shapeParams(fields: Record<string, unknown>, had: FlowEdgeShape): FlowEdgeShape {
  return {
    fromSide: fields.fromSide === undefined ? had.fromSide : oneOf(fields, 'fromSide', FLOW_EDGE_SIDES),
    toSide: fields.toSide === undefined ? had.toSide : oneOf(fields, 'toSide', FLOW_EDGE_SIDES),
    style: fields.style === undefined ? had.style : oneOf(fields, 'style', CONNECTOR_STYLES),
    points: fields.points === undefined ? had.points : pointsParam(fields, 'points'),
  };
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
  const selectPair = db.prepare('SELECT id FROM flow_edges WHERE from_session_id = ? AND to_session_id = ?');
  const selectAutoOut = db.prepare("SELECT * FROM flow_edges WHERE from_session_id = ? AND trigger = 'auto' ORDER BY rowid");
  const selectHeld = db.prepare('SELECT * FROM flow_edges WHERE held_since IS NOT NULL ORDER BY rowid');
  const selectHeldOut = db.prepare('SELECT * FROM flow_edges WHERE held_since IS NOT NULL AND from_session_id = ? ORDER BY rowid');
  const selectQueued = db.prepare('SELECT * FROM flow_edges WHERE queued_since IS NOT NULL AND paused = 0 ORDER BY rowid');
  const selectQueuedIn = db.prepare('SELECT * FROM flow_edges WHERE queued_since IS NOT NULL AND paused = 0 AND to_session_id = ? ORDER BY rowid');
  const selectOfAgent = db.prepare('SELECT id FROM flow_edges WHERE from_session_id = ? OR to_session_id = ?');
  /**
   * The edges that hand off by themselves: auto ones. A named hand-off's one-off edge is left out, so a reply along it
   * is never refused; it never relaunches an ended agent instead (`handOffOnce`), which keeps two agents from starting
   * each other for ever.
   */
  const selectAutoEdges = db.prepare("SELECT id, from_session_id, to_session_id FROM flow_edges WHERE trigger = 'auto'");
  const selectEvents = db.prepare('SELECT at, kind, detail FROM flow_edge_events WHERE edge_id = ? ORDER BY id DESC LIMIT ?');
  const countDeliveries = db.prepare("SELECT count(*) AS n FROM flow_edge_events WHERE edge_id = ? AND kind = 'delivered'");
  const agentExists = db.prepare('SELECT 1 FROM agents WHERE session_id = ?');
  const selectOut = db.prepare('SELECT * FROM flow_edges WHERE from_session_id = ? ORDER BY rowid');
  const insert = db.prepare(
    `INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, path, conditions, deliver_as, paused, made_by, one_off,
     from_side, to_side, style, points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateEnds = db.prepare(
    `UPDATE flow_edges SET from_session_id = ?, to_session_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const updateShape = db.prepare(
    `UPDATE flow_edges SET from_side = ?, to_side = ?, style = ?, points = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const keepOneOff = db.prepare('UPDATE flow_edges SET one_off_name = ?, one_off_text = ? WHERE id = ?');
  const updatePayload = db.prepare(
    "UPDATE flow_edges SET payload = ?, path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
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
  /** What each edge last delivered, by id. Only memory holds it: it may be anything the agent wrote. */
  const lastPayloads = new Map<string, FlowDeliveredPayload>();
  /** Per agent, the edges it handed off along explicitly in the turn under way: its Stop leaves them out. */
  const handedOff = new Map<string, Set<string>>();

  const conditionsOf = (row: FlowEdgeRow) => JSON.parse(row.conditions) as FlowCondition[];
  /**
   * The approvals kept on an edge, by command: each bound to the sender session and the worktree it was given for. One
   * kept as a bare fingerprint was given before an edge's sender could change, so it is bound to its sender as it is.
   */
  const approvalsOf = (row: FlowEdgeRow) => JSON.parse(row.approvals) as Record<string, KeptApproval>;
  /**
   * The approvals that hold for the edge's sender as it is now, `sender` in `worktree`: those given for exactly that
   * session and worktree. Any other was given for another agent's worktree, and runs nothing here.
   */
  const approvalsFor = (row: FlowEdgeRow, worktree: string): Approvals =>
    Object.fromEntries(
      Object.entries(approvalsOf(row)).flatMap(([command, kept]) =>
        typeof kept === 'string'
          ? [[command, kept]]
          : kept.sessionId === row.from_session_id && kept.worktree === worktree
            ? [[command, kept.fingerprint]]
            : [],
      ),
    );
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
      madeBy: row.made_by,
      oneOff: row.one_off === 1,
      fromSide: row.from_side,
      toSide: row.to_side,
      style: row.style,
      points: JSON.parse(row.points) as FlowEdge['points'],
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

  /**
   * Whether an auto edge from `from` to `to` would close a loop: `to` already reaches `from` along auto edges, other
   * than edge `moving`, which is the one going there.
   */
  const closesAutoLoop = (from: string, to: string, moving?: string) => {
    const next = new Map<string, string[]>();
    for (const row of selectAutoEdges.all() as unknown as Pick<FlowEdgeRow, 'id' | 'from_session_id' | 'to_session_id'>[]) {
      if (row.id === moving) continue;
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
  const refuseAutoLoop = (from: string, to: string, moving?: string) => {
    if (closesAutoLoop(from, to, moving)) {
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

  /**
   * Tries `payload` along the edge to its `to` agent: how it went. An ended `to` starts again, along any edge, whoever
   * made it (ADR-0012).
   */
  const attempt = async (row: FlowEdgeRow, payload: Payload): Promise<RunStart> => {
    recount(delivering, row.id, 1);
    announceId(row.id);
    const result = await options
      .deliver(row.from_session_id, row.to_session_id, payload.name, payload.text)
      .catch((error: Error): RunStart => ({ started: false, reason: `it could not be sent: ${error.message}` }))
      .finally(() => recount(delivering, row.id, -1));
    if (result.started) lastPayloads.set(row.id, { name: payload.name, text: payload.text, at: new Date().toISOString() });
    return result;
  };

  /**
   * Delivers `payload` along the edge and records how it went. Never throws: a failed delivery is a skipped one. One
   * its `to` agent can't take now is queued instead, on an edge that queues, until that agent's turn ends.
   */
  const deliverAlong = async (
    row: FlowEdgeRow,
    payload: Payload,
    copy = keepsCopy(row),
  ): Promise<{ edge: FlowEdge; outcome: Outcome } | undefined> => {
    const result = await attempt(row, payload);
    if (!result.started && result.busy === true && find(row.id)?.deliver_as === 'queue') {
      if (updateQueue.run(payload.name, copy ? payload.text : null, row.id).changes === 0) return undefined;
      record(row.id, 'queued', result.reason);
      return { edge: announce(get(row.id)), outcome: { outcome: 'queued', name: payload.name, reason: result.reason } };
    }
    if (!result.started) options.log(`flow edge ${row.id} skipped delivering to ${row.to_session_id}: ${result.reason}`);
    // Either agent may have gone meanwhile, and the edge with it.
    if (updateDelivery.run(result.started ? null : result.reason, row.id).changes === 0) return undefined;
    record(row.id, result.started ? 'delivered' : 'skipped', result.started ? `${payload.name} (${size(payload.bytes)})` : result.reason);
    const outcome: Outcome = result.started
      ? { outcome: 'delivered', name: payload.name, reason: null }
      : { outcome: 'skipped', name: payload.name, reason: result.reason };
    return { edge: announce(get(row.id)), outcome };
  };

  /** Checks the edge's conditions, keeping how each did: the first that failed, or undefined when all passed. */
  const failing = async (row: FlowEdgeRow): Promise<string | undefined> => {
    const conditions = conditionsOf(row);
    if (conditions.length === 0) return undefined;
    const agent = options.agent(row.from_session_id);
    if (agent === undefined) return 'its agent has been deleted';
    const agentOf = { sessionId: row.from_session_id, worktree: agent.worktree };
    const results = await options.conditions.all(conditions, agentOf, approvalsFor(row, agent.worktree));
    // Its conditions, approvals or sender may have changed meanwhile: these checks are of the old ones, so check the new.
    const now = find(row.id);
    if (now === undefined) return 'its edge has been deleted';
    if (now.conditions !== row.conditions || now.approvals !== row.approvals || now.from_session_id !== row.from_session_id) return failing(now);
    checks.set(row.id, results);
    return results.find((result) => !result.passed)?.detail;
  };

  /** What its checks found, without when: a check again that found the same tells no one. */
  const findings = (id: string) => JSON.stringify(checks.get(id)?.map((check) => check && [check.passed, check.detail]));

  /**
   * An auto hand-off along one edge: delivered, or held until its conditions pass. `given` is what an explicit hand-off
   * gave it to carry (`handOffExplicitly`), else it carries its own payload as it is now. Resolves with how it went,
   * or undefined for an edge gone or made manual meanwhile.
   */
  const handOffAlong = (id: string, given?: () => Promise<PayloadOrProblem>) =>
    serially(id, async (): Promise<Outcome | undefined> => {
      const skipped = (name: string, reason: string): Outcome => {
        skip(id, reason);
        return { outcome: 'skipped', name, reason };
      };
      // Its rules may have changed while an earlier hand-off along it was checked.
      const row = find(id);
      if (row?.trigger !== 'auto') return undefined;
      const name = payloadName(row.payload, row.path);
      if (row.paused === 1) return skipped(name, 'the edge was paused');
      const payload = await (given ?? (() => read(row)))();
      if ('problem' in payload) return skipped(payload.name, payload.problem);
      const failed = await failing(row);
      // Its rules may have changed while it was checked (a gate takes minutes): as they are now, not as they were.
      const now = find(id);
      if (now === undefined) return undefined;
      if (now.trigger !== 'auto') return skipped(payload.name, 'it was made manual while it was checked');
      if (now.payload !== row.payload || now.path !== row.path) return skipped(payload.name, 'its payload changed while it was checked');
      // What an explicit hand-off gave it is no file to read again later: a copy is kept, whatever the setting.
      const copy = given !== undefined || keepsCopy(now);
      if (failed === undefined && now.paused === 0) {
        // This newer hand-off replaces any held.
        clearHold.run(id, now.held_since);
        return (await deliverAlong(now, payload, copy))?.outcome;
      }
      // Paused while it was checked, it waits like one held: checked again once resumed.
      const reason = failed ?? 'the edge was paused while it was checked';
      if (updateHold.run(payload.name, copy ? payload.text : null, reason, id).changes === 0) return undefined;
      record(id, 'held', reason);
      announceId(id);
      return { outcome: 'held', name: payload.name, reason };
    });

  /**
   * What an explicit hand-off gives the edge to carry, by what it carries: a final message the `message` (and nothing
   * without one, since its last is from an earlier turn), a handover the file `handoverPath`, JSON the value `json`; or
   * undefined for a file edge given none, which carries its own file. Throws `invalidParams` for a bad path.
   */
  /**
   * Throws `invalidParams` for what a hand-off along no edge gives that one would refuse: a message or JSON over
   * `MAX_PAYLOAD_BYTES`, or a handover file that isn't a file of at most that inside its worktree.
   */
  const checkLoosePayload = async (sessionId: string, payload: HandoffPayload): Promise<void> => {
    for (const [what, text] of [['message', payload.message], ['JSON', payload.json === undefined ? undefined : JSON.stringify(payload.json)]] as const) {
      if (text !== undefined && Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
        throw invalidParams(`the ${what} is over ${MAX_PAYLOAD_BYTES / 1024} KB, too big to hand on`);
      }
    }
    const agent = options.agent(sessionId);
    if (payload.handoverPath === undefined || agent === undefined) return;
    const read = await readPayload({ payload: 'handover', path: checkPayloadPath(payload.handoverPath), worktree: agent.worktree, finalMessage: undefined });
    if ('problem' in read) throw invalidParams(read.problem);
  };

  const givenFor = (row: FlowEdgeRow, payload: HandoffPayload): (() => Promise<PayloadOrProblem>) | undefined => {
    const name = payloadName(row.payload, row.path);
    const sized = (what: string, text: string) => {
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_PAYLOAD_BYTES) throw invalidParams(`the ${what} is over ${MAX_PAYLOAD_BYTES / 1024} KB, too big to hand on`);
      return bytes;
    };
    switch (row.payload) {
      case 'final-message': {
        const { message } = payload;
        if (message === undefined) {
          const problem = 'give a message to hand off along it: its final message is from a turn it finished before';
          return async () => ({ name, problem });
        }
        const bytes = sized('message', message);
        return async () => ({ name: 'message', text: message, bytes });
      }
      case 'handover': {
        if (payload.handoverPath === undefined) return undefined;
        const path = checkPayloadPath(payload.handoverPath);
        return async () => {
          const agent = options.agent(row.from_session_id);
          if (agent === undefined) return { name, problem: 'its agent has been deleted' };
          return readPayload({ payload: 'handover', path, worktree: agent.worktree, finalMessage: undefined });
        };
      }
      case 'json': {
        if (payload.json === undefined) return undefined;
        const text = JSON.stringify(payload.json);
        const bytes = sized('JSON', text);
        return async () => ({ name, text, bytes });
      }
    }
  };

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
      // A copy it held stays a copy if it is queued now: it may be what an explicit hand-off gave it.
      await deliverAlong(now, payload, now.held_text !== null || keepsCopy(now));
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

  /** Refuses an edge from `from` to `to`, other than edge `moving`: to itself, to an agent that isn't there, or a second one that way. */
  const refuseEnds = (from: string, to: string, moving?: string) => {
    if (from === to) throw invalidParams('a flow edge can not join an agent to itself');
    for (const end of [from, to]) if (agentExists.get(end) === undefined) throw invalidParams(`no agent ${end}`);
    const pair = selectPair.get(from, to) as { id: string } | undefined;
    if (pair !== undefined && pair.id !== moving) throw invalidParams('a flow edge already joins those agents that way');
  };

  /** Makes an edge from a client's params, marked as made by `madeBy` if given. */
  const create = (params: unknown, madeBy?: string): FlowEdge => {
    const fields = paramsObject(params);
    const from = stringParam(fields, 'from');
    const to = stringParam(fields, 'to');
    const trigger = fields.trigger === undefined ? 'auto' : oneOf(fields, 'trigger', FLOW_EDGE_TRIGGERS);
    const payload = fields.payload === undefined ? 'final-message' : oneOf(fields, 'payload', FLOW_EDGE_PAYLOADS);
    const path = pathFor(payload, fields.path);
    const conditions = fields.conditions === undefined ? [] : conditionsParam(fields.conditions);
    const deliverAs = fields.deliverAs === undefined ? 'message' : oneOf(fields, 'deliverAs', FLOW_EDGE_DELIVERY_MODES);
    const paused = optionalBooleanParam(fields, 'paused') ?? false;
    refuseEnds(from, to);
    if (trigger === 'auto') refuseAutoLoop(from, to);
    const id = fields.id === undefined ? randomUUID() : stringParam(fields, 'id');
    if (!CLIENT_ID.test(id)) throw invalidParams('a flow edge id is letters, digits and -, at most 64');
    if (find(id) !== undefined) throw invalidParams(`flow edge ${id} already exists`);
    const shape = shapeParams(fields, DEFAULT_FLOW_EDGE_SHAPE);
    insert.run(
      id,
      from,
      to,
      trigger,
      payload,
      path,
      JSON.stringify(conditions),
      deliverAs,
      paused ? 1 : 0,
      madeBy ?? null,
      0,
      shape.fromSide,
      shape.toSide,
      shape.style,
      JSON.stringify(shape.points),
    );
    return announce(get(id));
  };

  /** What a named hand-off's one-off edge carries, by what it was given: a message, else a handover file, else JSON. */
  const oneOffPayload = (payload: HandoffPayload): { payload: FlowEdgePayload; path: string | null } => {
    if (payload.message !== undefined) return { payload: 'final-message', path: null };
    if (payload.handoverPath !== undefined) return { payload: 'handover', path: checkPayloadPath(payload.handoverPath) };
    if (payload.json !== undefined) return { payload: 'json', path: DEFAULT_PAYLOAD_PATHS.json };
    throw invalidParams('give a message, a handover file or JSON to hand to an agent you name');
  };

  /**
   * The one-off edge from `from` to `to` for a named hand-off: made, manual, marked as made by `from`, or the
   * one there carrying what this hand-off gives it now.
   */
  const oneOffEdge = (from: string, to: string, payload: HandoffPayload, had: FlowEdgeRow | undefined): FlowEdgeRow => {
    const carries = oneOffPayload(payload);
    if (had === undefined) {
      if (agentExists.get(to) === undefined) throw invalidParams(`no agent ${to}`);
      const id = randomUUID();
      // Its sides automatic, until it is reshaped.
      const { fromSide, toSide, style, points } = DEFAULT_FLOW_EDGE_SHAPE;
      insert.run(id, from, to, 'manual', carries.payload, carries.path, '[]', 'message', 0, from, 1, fromSide, toSide, style, JSON.stringify(points));
      announce(get(id));
      return find(id)!;
    }
    if (had.payload !== carries.payload || had.path !== carries.path) updatePayload.run(carries.payload, carries.path, had.id);
    return find(had.id)!;
  };

  /**
   * Delivers a named hand-off along its one-off edge at once: it has no conditions, and is the agent's own to send. It
   * never starts an ended agent again: the user ended it, and only the user's Send along the edge does.
   */
  const handOffOnce = (row: FlowEdgeRow, given: (() => Promise<PayloadOrProblem>) | undefined) =>
    serially(row.id, async (): Promise<Outcome | undefined> => {
      const to = options.agent(row.to_session_id);
      if (to !== undefined && to.endedAt !== null) {
        const reason = `${to.name} has ended: a named hand-off never starts it again, the user's Send or an edge the user drew does`;
        skip(row.id, reason);
        return { outcome: 'skipped', name: payloadName(row.payload, row.path), reason };
      }
      const payload = await (given ?? (() => read(row)))();
      if ('problem' in payload) {
        skip(row.id, payload.problem);
        return { outcome: 'skipped', name: payload.name, reason: payload.problem };
      }
      keepOneOff.run(payload.name, payload.text, row.id);
      const now = find(row.id);
      return now === undefined ? undefined : (await deliverAlong(now, payload, true))?.outcome;
    });

  /** What the edge carries now: a one-off edge what its last named hand-off carried (`keepOneOff`), else its payload. */
  const current = async (row: FlowEdgeRow): Promise<PayloadRead> =>
    row.one_off === 1 && row.one_off_text !== null
      ? { name: row.one_off_name ?? 'payload', text: row.one_off_text, shown: row.one_off_text, bytes: Buffer.byteLength(row.one_off_text) }
      : read(row);

  const removeEdge = (id: string) => {
    if (remove.run(id).changes === 0) throw invalidParams(`no flow edge ${id}`);
    checks.delete(id);
    lastPayloads.delete(id);
    options.broadcast({ type: 'flowEdge.removed', id });
  };

  return {
    handOff(sessionId) {
      // Its turn is over: what was queued for it can come now.
      for (const row of selectQueuedIn.all(sessionId) as unknown as FlowEdgeRow[]) void deliverQueued(row);
      const explicit = handedOff.get(sessionId);
      handedOff.delete(sessionId);
      for (const row of selectAutoOut.all(sessionId) as unknown as FlowEdgeRow[]) {
        if (explicit?.has(row.id) === true) continue;
        handOffAlong(row.id).catch((error: Error) => options.log(`could not hand off along flow edge ${row.id}: ${error.message}`));
      }
    },

    turnBoundary(sessionId) {
      handedOff.delete(sessionId);
    },

    async handOffExplicitly(sessionId, payload, to, onSettled, reach) {
      let out = (selectOut.all(sessionId) as unknown as FlowEdgeRow[]).filter((row) => to === undefined || row.to_session_id === to);
      // Named, with no edge of the user's to it (or its own one-off one): a one-off edge, where `reach` lets it.
      if (to !== undefined && reach !== undefined && (out.length === 0 || out[0]!.one_off === 1)) {
        reach(to);
        out = [oneOffEdge(sessionId, to, payload, out[0])];
      }
      // No edge leaves it at all: there is no one to hand to, but handing off still says it is finished, once
      // what it hands over passes the checks an edge would make of it.
      if (out.length === 0 && to === undefined) {
        await checkLoosePayload(sessionId, payload);
        return [];
      }
      if (out.length === 0) {
        throw invalidParams(`there is no edge from you to ${options.agent(to!)?.name ?? to}: you hand off only along your own edges`);
      }
      // Every payload is checked before any edge sets out.
      const given = new Map(out.map((row) => [row.id, givenFor(row, payload)]));
      // This turn's: a turn boundary since leaves it behind, so nothing done here reaches a later turn's.
      const turn = handedOff.get(sessionId) ?? new Set<string>();
      handedOff.set(sessionId, turn);
      return Promise.all(
        out.map(async (row): Promise<HandoffOutcome> => {
          const edge = { edgeId: row.id, to: row.to_session_id };
          const name = payloadName(row.payload, row.path);
          if (row.one_off === 1) {
            const once = await handOffOnce(row, given.get(row.id));
            return { ...edge, ...(once ?? { outcome: 'skipped', name, reason: 'the edge went as you handed off' }) };
          }
          if (row.trigger !== 'auto') return { ...edge, outcome: 'skipped', name, reason: 'the edge is manual: the user sends it' };
          // Its Stop leaves out an edge this turn handed off along; one skipped is left to it, to try with its final message.
          turn.add(row.id);
          const going = handOffAlong(row.id, given.get(row.id)).then((outcome): Outcome => {
            const settled = outcome ?? { outcome: 'skipped' as const, name, reason: 'the edge went, or was made manual, as you handed off' };
            if (settled.outcome === 'skipped') turn.delete(row.id);
            return settled;
          });
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<Outcome>((resolve) => {
            timer = setTimeout(() => resolve({ outcome: 'checking', name, reason: 'its conditions are still being checked' }), HANDOFF_ANSWER_MS);
          });
          const outcome = await Promise.race([going, late]).finally(() => clearTimeout(timer));
          if (outcome.outcome === 'checking') {
            void going.then((settled) => onSettled?.({ ...edge, ...settled })).catch(() => {});
          }
          return { ...edge, ...outcome };
        }),
      );
    },

    create,

    link: (from, to, madeBy) => {
      if (selectPair.get(from, to) !== undefined) return undefined;
      return create({ from, to, trigger: 'manual' }, madeBy);
    },

    get: (id) => {
      const row = find(id);
      return row === undefined ? undefined : toFlowEdge(row);
    },

    remove: removeEdge,

    recheck(sessionId) {
      for (const row of selectHeldOut.all(sessionId) as unknown as FlowEdgeRow[]) recheckHeld(row);
    },

    dropAgent(sessionId) {
      handedOff.delete(sessionId);
      for (const { id } of selectOfAgent.all(sessionId, sessionId) as unknown as Pick<FlowEdgeRow, 'id'>[]) removeEdge(id);
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
      'flowEdge.create': (params) => create(params),
      'flowEdge.update': (params) => {
        const fields = paramsObject(params);
        const row = find(stringParam(fields, 'id'));
        if (row === undefined) throw invalidParams(`no flow edge ${String(fields.id)}`);
        // How it is drawn changes nothing it does, so a reshape alone touches none of its rules, holds or queue. Every
        // field is checked before any is saved, so a call refused for one changes nothing.
        const shape = shapeParams(fields, toFlowEdge(row));
        // An end moved onto another agent is checked as a new edge between them would be.
        const from = fields.from === undefined ? row.from_session_id : stringParam(fields, 'from');
        const to = fields.to === undefined ? row.to_session_id : stringParam(fields, 'to');
        const newSender = from !== row.from_session_id;
        const moving = newSender || to !== row.to_session_id;
        if (moving) refuseEnds(from, to, row.id);
        const reshape = () => {
          if (FLOW_EDGE_SHAPE_KEYS.some((name) => fields[name] !== undefined)) {
            updateShape.run(shape.fromSide, shape.toSide, shape.style, JSON.stringify(shape.points), row.id);
          }
          if (!moving) return;
          updateEnds.run(from, to, row.id);
          checks.delete(row.id);
          // Its gates and scripts run in its sender's worktree: what was approved there is never approved in another's.
          if (newSender) updateApprovals.run('{}', row.id);
          // What it held or queued was handed off to the agent it left, or by the one it left.
          const reason = 'it was moved to another agent while it was';
          if (row.held_since !== null && clearHold.run(row.id, row.held_since).changes > 0) record(row.id, 'skipped', `${reason} held`);
          if (row.queued_since !== null && clearQueue.run(row.id, row.queued_since).changes > 0) record(row.id, 'skipped', `${reason} queued`);
        };
        if (!RULE_FIELDS.some((name) => fields[name] !== undefined)) {
          if (moving && row.trigger === 'auto') refuseAutoLoop(from, to, row.id);
          reshape();
          return announce(get(row.id));
        }
        const trigger = fields.trigger === undefined ? row.trigger : oneOf(fields, 'trigger', FLOW_EDGE_TRIGGERS);
        const payload = fields.payload === undefined ? row.payload : oneOf(fields, 'payload', FLOW_EDGE_PAYLOADS);
        const path = pathFor(payload, fields.path, row);
        const conditions = fields.conditions === undefined ? row.conditions : JSON.stringify(conditionsParam(fields.conditions));
        // An approval goes with its command: a command typed again, or changed, is approved again.
        const commands = commandsOf(JSON.parse(conditions) as FlowCondition[]);
        // A new sender has approved nothing yet.
        const approved = newSender ? {} : approvalsOf(row);
        const approvals = JSON.stringify(Object.fromEntries(Object.entries(approved).filter(([command]) => commands.includes(command))));
        const deliverAs = fields.deliverAs === undefined ? row.deliver_as : oneOf(fields, 'deliverAs', FLOW_EDGE_DELIVERY_MODES);
        const paused = optionalBooleanParam(fields, 'paused') ?? row.paused === 1;
        if (trigger === 'auto' && (moving || row.trigger !== 'auto')) refuseAutoLoop(from, to, row.id);
        reshape();
        updateRules.run(trigger, payload, path, conditions, approvals, deliverAs, paused ? 1 : 0, row.id);
        if (conditions !== row.conditions) checks.delete(row.id);
        // A move dropped what it held and queued.
        if (row.held_since !== null && !moving) {
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
        if (row.queued_since !== null && !moving) {
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
        removeEdge(stringParam(paramsObject(params), 'id'));
        return null;
      },
      'flowEdge.send': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        // A one-off edge replays what its last named hand-off carried.
        const payload = await current(row);
        if ('problem' in payload) throw invalidParams(payload.problem);
        if (row.held_since !== null && clearHold.run(id, row.held_since).changes > 0) {
          record(id, 'released', 'sent by hand');
        }
        // A newer delivery replaces the one queued.
        clearQueue.run(id, row.queued_since);
        const sent = await deliverAlong(row, payload, keepsCopy(row));
        if (sent === undefined) throw invalidParams(`flow edge ${id} went while it was being sent`);
        return sent.edge;
      },
      'flowEdge.preview': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const payload = await current(row);
        return 'problem' in payload ? payload : { name: payload.name, text: payload.shown, bytes: payload.bytes };
      },
      'flowEdge.commands': async (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        const agent = options.agent(row.from_session_id);
        if (agent === undefined) throw invalidParams(`flow edge ${id}'s agent has been deleted`);
        const approvals = approvalsFor(row, agent.worktree);
        return Promise.all(
          commandsOf(conditionsOf(row)).map(async (command): Promise<FlowCommandApproval> => {
            const plan = await commandPlan(command, agent.worktree);
            const approved = Object.hasOwn(approvals, command) ? approvals[command] : undefined;
            const approval = approved === undefined ? 'unapproved' : approved === plan.fingerprint ? 'approved' : 'changed';
            return { ...plan, approval, from: row.from_session_id };
          }),
        );
      },
      'flowEdge.approve': async (params) => {
        const fields = paramsObject(params);
        const id = stringParam(fields, 'id');
        const command = stringParam(fields, 'command');
        const fingerprint = stringParam(fields, 'fingerprint');
        // The sender the user looked at it for: an approval is for one agent's worktree, never another's.
        const seenFor = fields.from === undefined ? undefined : stringParam(fields, 'from');
        const row = find(id);
        if (row === undefined) throw invalidParams(`no flow edge ${id}`);
        if (!commandsOf(conditionsOf(row)).includes(command)) throw invalidParams(`flow edge ${id} runs no ${command}`);
        const movedAway = () => invalidParams(`flow edge ${id} hands off from another agent now: look at what ${command} runs there again`);
        if (seenFor !== undefined && seenFor !== row.from_session_id) throw movedAway();
        const agent = options.agent(row.from_session_id);
        if (agent === undefined) throw invalidParams(`flow edge ${id}'s agent has been deleted`);
        const plan = await commandPlan(command, agent.worktree);
        if (plan.fingerprint !== fingerprint) throw invalidParams(`what ${command} runs has changed since you looked at it: look again`);
        // Read again: its rules, or its sender and so where it runs, may have changed while the plan was read.
        const now = find(id);
        if (now === undefined || !commandsOf(conditionsOf(now)).includes(command)) throw invalidParams(`flow edge ${id} runs no ${command} any more`);
        if (now.from_session_id !== row.from_session_id || options.agent(now.from_session_id)?.worktree !== agent.worktree) throw movedAway();
        const kept: KeptApproval = { fingerprint, sessionId: now.from_session_id, worktree: agent.worktree };
        updateApprovals.run(JSON.stringify({ ...approvalsOf(now), [command]: kept }), id);
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
      'flowEdge.lastPayload': (params) => {
        const id = stringParam(paramsObject(params), 'id');
        if (find(id) === undefined) throw invalidParams(`no flow edge ${id}`);
        return lastPayloads.get(id) ?? null;
      },
    }),
  };
}
