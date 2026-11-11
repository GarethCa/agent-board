// A folded zone (a zone the user folded away while it isn't needed): drawn as a chip at the place the zone has, with
// nothing of what is in it drawn. Only the nodes as drawn change; the zone keeps its saved size, and its tiles their
// places, so unfolding puts it all back. The chip is the room it takes on the board meanwhile, so unfolding first moves
// what has come to sit where it opens. Pure, so it is unit-tested.
import { BOARD_ARRANGE_GAP } from '@agent-board/daemon/arrange-board';
import { overlaps, sizedFootprint, type Point, type Rect, type Size } from '@agent-board/daemon/board-layout';
import { HUMAN_STATUS_BY_STATE } from '@agent-board/daemon/human-status';
import { drawnZoneSize, type Agent, type ExternalSession, type Shell, type Zone, type ZoneFoldResult, type ZoneUnfoldResult } from '@agent-board/daemon/protocol';
import type { ProjectSummary } from './project-summary';
import type { TileNodeType } from './tile';
import { EXTERNAL_NODE_PREFIX, isSessionTile, isZone, layoutOf, type BoardNode } from './tiles';
import type { ZoneNodeType } from './ZoneNode';

/**
 * The room the zone takes on the board: as it is drawn (grown to hold its tiles), or folded, its chip. From its node as
 * saved, which keeps the zone's full size while it is folded.
 */
export function roomOf(node: ZoneNodeType): Rect {
  return { ...layoutOf(node), ...(node.data.zone.folded ? drawnZoneSize(node.data.zone) : {}) };
}

/**
 * `nodes` with each folded zone drawn as its chip, and everything in it (tiles, notes, cards) hidden, with the lines to
 * them. The same array when no zone is folded.
 */
export function withFoldedZones(nodes: readonly BoardNode[]): BoardNode[] {
  const folded = new Set(nodes.filter((node): node is ZoneNodeType => isZone(node) && node.data.zone.folded).map((node) => node.id));
  if (folded.size === 0) return [...nodes];
  return nodes.map((node): BoardNode => {
    if (isZone(node) && folded.has(node.id)) return { ...node, ...drawnZoneSize(node.data.zone) };
    return node.parentId !== undefined && folded.has(node.parentId) ? { ...node, hidden: true } : node;
  });
}

/**
 * The ids of the sessions in folded zones, whose terminals are let go: an agent's, a shell's, and the tabs of the agents
 * (shells of the agent's session window). Their sessions go on; only what the window holds for them is freed.
 */
export function foldedSessionIds(zones: readonly Pick<Zone, 'id' | 'folded'>[], agents: readonly Pick<Agent, 'sessionId' | 'zoneId'>[], shells: readonly Shell[]): Set<string> {
  const folded = new Set(zones.filter((zone) => zone.folded).map((zone) => zone.id));
  const ids = new Set<string>();
  const inFolded = (zoneId: string | null) => zoneId !== null && folded.has(zoneId);
  for (const agent of agents) if (inFolded(agent.zoneId)) ids.add(agent.sessionId);
  for (const shell of shells) if (shell.owner === undefined || shell.owner === null ? inFolded(shell.zoneId) : ids.has(shell.owner.id)) ids.add(shell.id);
  return ids;
}

/**
 * `summaries` with each folded zone's (`folded`, their ids) made its chip's: the external sessions in the zone are counted too, as the chip
 * hides their tiles with the rest. One that waits on a permission is with those that need the user, so it does not hide;
 * the others are "N external" after the agents' counts. The other zones' summaries are as they were.
 */
export function withFoldedExternals(
  summaries: ReadonlyMap<string, ProjectSummary>,
  folded: readonly string[],
  externals: readonly Pick<ExternalSession, 'zoneId' | 'state' | 'endedAt'>[],
): ReadonlyMap<string, ProjectSummary> {
  const all = new Map(summaries);
  for (const id of folded) {
    const inZone = externals.filter((session) => session.zoneId === id);
    if (inZone.length === 0) continue;
    const asking = inZone.filter((session) => session.endedAt === null && HUMAN_STATUS_BY_STATE[session.state] === 'needs-you').length;
    const rest = inZone.length - asking;
    const agents = summaries.get(id) ?? { needsYou: 0, line: '' };
    all.set(id, { needsYou: agents.needsYou + asking, line: [agents.line, rest > 0 ? `${rest} external` : ''].filter((part) => part !== '').join(' · ') });
  }
  return all;
}

/**
 * What a folded zone's chip says after its name and its count of those that need the user (`summary.needsYou`, drawn
 * apart): the rest by status, set off from that count when there is one, or that the zone has no agents.
 */
export function chipLine(summary: ProjectSummary | undefined): string {
  const { needsYou, line } = summary ?? { needsYou: 0, line: '' };
  if (line === '') return needsYou > 0 ? '' : 'No agents';
  return needsYou > 0 ? `· ${line}` : line;
}

/** Something on the bare board an unfolding zone moves out of its way, by its id and where it is. */
export interface InTheWay {
  id: string;
  rect: Rect;
}

/** Slack for positions worked out from fractional ones, px. */
const EPSILON = 1e-6;

/**
 * Where `movables` go so that the zone drawn as `chip` can open to `open`, from the same top left corner. Only what
 * `open` would cover moves, with what goes with it: what is below the chip moves down, and what is beside it, in its
 * row, moves right, each lot by the one shift that takes its nearest member `gap` clear of the open zone. Whatever is
 * within `gap` of one that moves, and on the same side of the chip, moves with it, and so does whatever is in its path,
 * so a row stays a row and nothing lands on a neighbour. What only lay over the chip itself stays, as it was put there.
 * Nothing moves when nothing is in the way. Only the movables that move are in the result, by id.
 */
export function roomToUnfold(chip: Rect, open: Rect, movables: readonly InTheWay[], gap = BOARD_ARRANGE_GAP): Map<string, Point> {
  const at = new Map(movables.map(({ id, rect }) => [id, rect]));
  const middle = chip.y + chip.height / 2;
  const below = (rect: Rect) => rect.y >= middle;
  const beside = (rect: Rect) => !below(rect) && rect.y + rect.height > chip.y && rect.x >= chip.x + chip.width - EPSILON;
  const near = (a: Rect, b: Rect) => overlaps({ x: a.x - gap - EPSILON, y: a.y - gap - EPSILON, width: a.width + 2 * (gap + EPSILON), height: a.height + 2 * (gap + EPSILON) }, b);
  /** Moves the lot `side` picks along `axis`, if any of it is in the way. */
  const shift = (axis: 'x' | 'y', side: (rect: Rect) => boolean) => {
    const now = movables.map(({ id }) => ({ id, rect: at.get(id)! }));
    const inTheWay = now.filter(({ rect }) => side(rect) && overlaps(rect, open));
    if (inTheWay.length === 0) return;
    const edge = axis === 'x' ? open.x + open.width : open.y + open.height;
    const by = edge + gap - Math.min(...inTheWay.map(({ rect }) => rect[axis]));
    // Where it passes on its way, and the gap it keeps ahead of it there.
    const path = (rect: Rect): Rect => (axis === 'x' ? { ...rect, width: rect.width + by + gap } : { ...rect, height: rect.height + by + gap });
    const moving = new Set(inTheWay.map(({ id }) => id));
    for (let found = inTheWay; found.length > 0; ) {
      const last = found;
      found = now.filter(({ id, rect }) => !moving.has(id) && last.some((mover) => overlaps(path(mover.rect), rect) || (side(rect) && near(mover.rect, rect))));
      for (const { id } of found) moving.add(id);
    }
    for (const id of moving) at.set(id, { ...at.get(id)!, [axis]: at.get(id)![axis] + by });
  };
  // What is beside it is judged with what was below moved down, so nothing goes right into something just lowered.
  shift('y', below);
  shift('x', beside);
  return new Map(movables.flatMap(({ id, rect }) => {
    const { x, y } = at.get(id)!;
    return x === rect.x && y === rect.y ? [] : [[id, { x, y }] as const];
  }));
}

/**
 * Where unfolding the zone `zoneId` moves what is in its way (`roomToUnfold`), by node id: the other zones, a folded one
 * as its chip, and the agents and shells loose on the board, each of `tileSize` with the room above it. The notes,
 * shapes and text loose on the board stay, as do other sessions' tiles, as in an arrange of the board. From the nodes as
 * saved, so the zone at its saved size: one laid out on shelves or in clusters may be drawn taller than that, and what
 * is just under its saved bottom then stays under it, as in an arrange of the board. Empty if the zone is not folded.
 */
export function unfoldMoves(nodes: readonly BoardNode[], zoneId: string, tileSize: (tile: TileNodeType) => Size): Map<string, Point> {
  const zone = nodes.find((node): node is ZoneNodeType => isZone(node) && node.id === zoneId);
  if (zone === undefined || !zone.data.zone.folded) return new Map();
  const movables = nodes.flatMap((node): InTheWay[] => {
    if (isZone(node)) return node.id === zoneId ? [] : [{ id: node.id, rect: roomOf(node) }];
    const loose = isSessionTile(node) && node.parentId === undefined && !node.id.startsWith(EXTERNAL_NODE_PREFIX);
    return loose ? [{ id: node.id, rect: sizedFootprint(node.position, tileSize(node)) }] : [];
  });
  const moves = roomToUnfold(roomOf(zone), layoutOf(zone), movables);
  // A tile's place is its own top left, below the room above it.
  return new Map(movables.flatMap(({ id, rect }) => {
    const spot = moves.get(id);
    const from = nodes.find((node) => node.id === id)!.position;
    return spot === undefined ? [] : [[id, { x: from.x + spot.x - rect.x, y: from.y + spot.y - rect.y }] as const];
  }));
}

/** A toast's tone and words. */
export interface FoldToast {
  tone: 'success' | 'info';
  message: string;
}

const agentCount = (count: number) => `${count} ${count === 1 ? 'agent' : 'agents'}`;

/**
 * Each agent a fold or an unfold left as it was, with why: "Alpha, as it is mid-turn". The daemon's reason may end in
 * what to do about it, after a colon ("it is mid-turn: finish its turn first"), which a list of several has no room for.
 */
const leftAs = (left: readonly { name: string; why: string }[]) => left.map(({ name, why }) => `${name}, as ${why.split(': ')[0]}`).join('; ');

/**
 * What the board says once a zone is folded: how many of its agents were paused, and those left running and why. Not
 * a success when some were left: the memory they hold was not freed.
 */
export function foldedToast({ zone, paused, kept }: ZoneFoldResult): FoldToast {
  return {
    tone: kept.length > 0 ? 'info' : 'success',
    message: [`${zone.name} is folded.`, ...(paused.length > 0 ? [`${agentCount(paused.length)} paused.`] : []), ...(kept.length > 0 ? [`Left running: ${leftAs(kept)}.`] : [])].join(' '),
  };
}

/**
 * What the board says once a zone is unfolded: how many of its agents are waking, those asked that would not wake and
 * why, and how many stay paused (`paused`: all still paused in it, those that would not wake among them). Not a
 * success when one asked to wake would not.
 */
export function unfoldedToast({ zone, woken, asleep }: ZoneUnfoldResult, paused: number): FoldToast {
  const rest = paused - asleep.length;
  return {
    tone: asleep.length > 0 ? 'info' : 'success',
    message: [
      `${zone.name} is unfolded.`,
      ...(woken.length > 0 ? [`${agentCount(woken.length)} waking.`] : []),
      ...(asleep.length > 0 ? [`Still paused: ${leftAs(asleep)}.`] : []),
      ...(rest > 0 ? [`${agentCount(rest)} ${rest === 1 ? 'stays' : 'stay'} paused until you wake ${rest === 1 ? 'it' : 'them'}.`] : []),
    ].join(' '),
  };
}
