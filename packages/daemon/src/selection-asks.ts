// Ask Claude about a selection: the user selects part of a diagram on the board and asks an agent about it. The agent
// starts with the selection as a picture and as a diagram in its first message; its first answer comes back to the
// board as an agent note beside the selection, joined to it by an arrow, with its suggested edits drawn as ghosts.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { agentNoteAuthor, agentNoteData, agentNoteSize } from './agent-notes.ts';
import { isObject } from './json.ts';
import { dimensionParam, finiteNumberParam, invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  CONNECTOR_END_TYPES,
  HARNESSES,
  roleLabel,
  MAX_STICKY_TEXT,
  MAX_SUGGESTED_ARROWS,
  MAX_SUGGESTED_SHAPES,
  MAX_SUGGESTIONS,
  SHAPE_TYPES,
  type Agent,
  type AskSelectionParams,
  type BoardPlace,
  type ConnectorEndType,
  type DaemonMethods,
  type ImageRef,
  type SelectionDiagram,
  type SelectionNode,
  type ShapeType,
  type SpawnAgentParams,
  type SuggestedArrow,
  type SuggestedEdit,
  type SuggestedEnd,
  type SuggestedShape,
} from './protocol.ts';
import { cutText } from './text-cut.ts';
import type { FolderPlace } from './agent-spawns.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import type { RpcHandlers } from './rpc.ts';

type SelectionAskMethods = Pick<DaemonMethods, 'selection.ask'>;

/** The role an asked agent starts in when none is picked: a named custom role, which starts with its task alone. */
const DEFAULT_ASK_ROLE = 'architect';
/** The tag of the fenced block an answer ends with to suggest edits. */
export const SUGGESTIONS_FENCE = 'agent-board-suggestions';
/** The most a selection's diagram may take as JSON, in bytes: it goes in the agent's first message. */
const MAX_DIAGRAM_BYTES = 64 * 1024;
/** The most characters of what the user asks; and of a suggestion's title, a suggested shape's text and arrow's label. */
const MAX_QUESTION = 2_000;
const MAX_TITLE = 60;
const MAX_SHAPE_TEXT = 200;
const MAX_LABEL = 80;
/** The size a suggested shape keeps within, px; and the gap between the answer note and the agent's tile under it. */
const MIN_SHAPE_SIDE = 16;
const MAX_SHAPE_SIDE = 1_000;
const NOTE_TILE_GAP = 16;
/** How far from the selection a suggested shape may be put, px: further is kept at that. */
const MAX_REACH = 2_000;

/** A selection's picture and diagram as files, for its prompt to name. */
export interface SelectionFiles {
  picture: string;
  diagram: string;
}

/**
 * The agent's first message: what the user asked, then where the picture and the diagram are, the diagram itself, and
 * how to answer so the answer lands on the board (and, with `suggest`, how to suggest edits).
 */
export function selectionPrompt(ask: Pick<AskSelectionParams, 'question' | 'diagram' | 'readRepo' | 'suggest' | 'pictureScale'>, files: SelectionFiles): string {
  const shapes = ask.diagram.nodes.filter((node) => node.kind === 'shape').length;
  const lines = [
    ask.question.trim(),
    '',
    `The user selected part of a diagram on their board (${counted(ask.diagram.nodes.length, 'object')}, ${counted(ask.diagram.edges.length, 'arrow')}${shapes > 0 ? `, ${counted(shapes, 'shape')} among them` : ''}) and asked you about it.`,
    `- The picture: \`${files.picture}\` (drawn at ${ask.pictureScale ?? 2}×: only the selected objects, cropped to them). Look at it.`,
    `- Its structure, below and in \`${files.diagram}\`: each node's id, kind, text and box (x, y, width, height in board px from the selection's top-left), the arrows between nodes, and the zones they are in.`,
    '',
    '```json',
    JSON.stringify(ask.diagram, null, 1),
    '```',
    '',
    ask.readRepo
      ? "Your working directory is the user's checkout of the repo this diagram is about: read it for context. You are in a read-only mode: change nothing."
      : "You have no copy of the user's code: work from the diagram alone.",
    '',
    'Your final message is put on the board as a note beside the selection, as you write it, in Markdown: a bold one-line summary first (such as **3 risks, 1 gap**), then a short numbered list of findings (risks, gaps, alternatives, questions). Keep it short. The user asks any follow-up here.',
  ];
  if (ask.suggest) {
    lines.push(
      '',
      `To suggest changes to the diagram, end that message with a fenced block tagged ${SUGGESTIONS_FENCE}: a JSON array of at most ${MAX_SUGGESTIONS} suggestions, each {"title": a few words, "shapes": [{"id", "shape", "text", "x", "y", "width", "height"}], "arrows": [{"from", "to", "label"}]}. Shapes are in the selection's coordinates, beside what they join; an arrow's ends are node ids from the structure above or your new shapes' ids. Each is drawn on the diagram for the user to accept or dismiss. Leave the block out to suggest nothing.`,
      `The shapes: ${SHAPE_TYPES.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** How an answer's suggestions are read: the objects its arrows may join, and where the selection's (0, 0) is. */
export interface AnswerContext {
  objects: Record<string, { type: ConnectorEndType; id: string }>;
  origin: { x: number; y: number };
}

/**
 * An answer as its note shows it: its text without the suggestions block, and the suggestions in it that make sense,
 * on the board. A suggestion, shape or arrow that doesn't (an unknown shape or node, a missing title) is dropped.
 */
export function parseAnswer(message: string, context: AnswerContext): { text: string; suggestions: SuggestedEdit[] } {
  const fence = new RegExp(`\\n?\`{3,}[ \\t]*${SUGGESTIONS_FENCE}[ \\t]*\\n([\\s\\S]*?)\\n\`{3,}[ \\t]*(?=\\n|$)`, 'g');
  const blocks = [...message.matchAll(fence)];
  const text = message.replace(fence, '').trim();
  const block = blocks.at(-1)?.[1];
  if (block === undefined) return { text, suggestions: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return { text, suggestions: [] };
  }
  if (!Array.isArray(raw)) return { text, suggestions: [] };
  const suggestions = raw
    .flatMap((entry) => suggestion(entry, context) ?? [])
    .slice(0, MAX_SUGGESTIONS)
    .map((each, index) => ({ ...each, id: String(index + 1) }));
  return { text, suggestions };
}

function suggestion(raw: unknown, { objects, origin }: AnswerContext): Omit<SuggestedEdit, 'id'> | undefined {
  if (!isObject(raw) || typeof raw.title !== 'string' || raw.title.trim() === '') return undefined;
  const shapes = (Array.isArray(raw.shapes) ? raw.shapes : []).flatMap((entry) => suggestedShape(entry, origin) ?? []).slice(0, MAX_SUGGESTED_SHAPES);
  const keys = new Set(shapes.map((shape) => shape.key));
  const end = (ref: unknown): SuggestedEnd | undefined => {
    if (typeof ref !== 'string') return undefined;
    if (keys.has(ref)) return { shape: ref };
    const object = Object.hasOwn(objects, ref) ? objects[ref] : undefined;
    return object === undefined ? undefined : { object };
  };
  const arrows = (Array.isArray(raw.arrows) ? raw.arrows : [])
    .flatMap((entry): SuggestedArrow[] => {
      if (!isObject(entry)) return [];
      const from = end(entry.from);
      const to = end(entry.to);
      if (from === undefined || to === undefined || JSON.stringify(from) === JSON.stringify(to)) return [];
      return [{ from, to, label: typeof entry.label === 'string' ? cutText(entry.label.trim(), MAX_LABEL) : '' }];
    })
    .slice(0, MAX_SUGGESTED_ARROWS);
  if (shapes.length === 0 && arrows.length === 0) return undefined;
  return { title: cutText(raw.title.trim(), MAX_TITLE), shapes, arrows };
}

function suggestedShape(raw: unknown, origin: { x: number; y: number }): SuggestedShape | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') return undefined;
  const shape = SHAPE_TYPES.find((type) => type === raw.shape);
  if (shape === undefined) return undefined;
  const numbers = [raw.x, raw.y, raw.width, raw.height];
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const [x, y, width, height] = numbers as number[];
  const reach = (value: number) => Math.round(Math.min(MAX_REACH, Math.max(-MAX_REACH, value)));
  const side = (value: number) => Math.round(Math.min(MAX_SHAPE_SIDE, Math.max(MIN_SHAPE_SIDE, value)));
  return {
    key: raw.id,
    shape: shape as ShapeType,
    text: typeof raw.text === 'string' ? cutText(raw.text.trim(), MAX_SHAPE_TEXT) : '',
    x: origin.x + reach(x!),
    y: origin.y + reach(y!),
    width: side(width!),
    height: side(height!),
  };
}

/** A selection's diagram as sent: checked for its shape and size, else `invalidParams`. */
export function checkDiagram(raw: unknown): SelectionDiagram {
  const problem = 'diagram must be { nodes, edges, groups }';
  if (!isObject(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.groups)) throw invalidParams(problem);
  if (raw.nodes.length === 0) throw invalidParams('a selection to ask about has something in it');
  const ids = new Set<string>();
  for (const node of raw.nodes as unknown[]) {
    const ok =
      isObject(node) &&
      typeof node.id === 'string' &&
      typeof node.kind === 'string' &&
      ['x', 'y', 'width', 'height'].every((key) => typeof node[key] === 'number' && Number.isFinite(node[key])) &&
      (node.text === undefined || typeof node.text === 'string') &&
      (node.shape === undefined || typeof node.shape === 'string');
    if (!ok) throw invalidParams("a diagram's node must be { id, kind, x, y, width, height } with an optional text and shape");
    ids.add((node as unknown as SelectionNode).id);
  }
  for (const edge of raw.edges as unknown[]) {
    const ok = isObject(edge) && typeof edge.from === 'string' && typeof edge.to === 'string' && (edge.label === undefined || typeof edge.label === 'string');
    if (!ok || !ids.has(edge.from as string) || !ids.has(edge.to as string)) throw invalidParams("a diagram's edge must join two of its nodes");
  }
  for (const group of raw.groups as unknown[]) {
    const ok = isObject(group) && typeof group.name === 'string' && Array.isArray(group.nodes) && group.nodes.every((id) => typeof id === 'string' && ids.has(id));
    if (!ok) throw invalidParams("a diagram's group must be { name, nodes } of its nodes");
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_DIAGRAM_BYTES) throw invalidParams('the selection is too large to ask about: select less');
  return raw as unknown as SelectionDiagram;
}

function placeParam(fields: Record<string, unknown>, name: string): BoardPlace {
  const place = fields[name];
  if (!isObject(place)) throw invalidParams(`${name} must be { zoneId, x, y }`);
  const zoneId = place.zoneId === null ? null : stringParam(place, 'zoneId');
  return { zoneId, x: finiteNumberParam(place, 'x'), y: finiteNumberParam(place, 'y') };
}

function objectsParam(fields: Record<string, unknown>, diagram: SelectionDiagram): AskSelectionParams['objects'] {
  const objects = fields.objects;
  if (!isObject(objects)) throw invalidParams('objects must map node ids to board objects');
  const checked: AskSelectionParams['objects'] = {};
  for (const node of diagram.nodes) {
    const object = objects[node.id];
    if (!isObject(object) || !CONNECTOR_END_TYPES.includes(object.type as ConnectorEndType) || typeof object.id !== 'string') {
      throw invalidParams(`objects must give node ${node.id}'s board object as { type, id }`);
    }
    checked[node.id] = { type: object.type as ConnectorEndType, id: object.id };
  }
  return checked;
}

/** How many picture pixels to a board px: a positive number, at most 4. */
function scaleParam(p: Record<string, unknown>): number {
  const scale = finiteNumberParam(p, 'pictureScale');
  if (scale <= 0 || scale > 4) throw invalidParams('pictureScale must be more than 0 and at most 4');
  return Math.round(scale * 100) / 100;
}

/** `selection.ask`'s params, checked. */
function askParams(params: unknown): AskSelectionParams {
  const p = paramsObject(params);
  const question = stringParam(p, 'question').trim();
  if (question === '') throw invalidParams('question must not be empty');
  if (question.length > MAX_QUESTION) throw invalidParams(`question must be at most ${MAX_QUESTION} characters`);
  const harness = optionalStringParam(p, 'harness');
  if (harness !== undefined && !HARNESSES.includes(harness as never)) throw invalidParams(`unknown harness ${harness}`);
  const diagram = checkDiagram(p.diagram);
  const anchor = stringParam(p, 'anchor');
  if (!diagram.nodes.some((node) => node.id === anchor)) throw invalidParams('anchor must be one of the diagram’s nodes');
  const origin = isObject(p.origin) ? { x: finiteNumberParam(p.origin, 'x'), y: finiteNumberParam(p.origin, 'y') } : undefined;
  if (origin === undefined) throw invalidParams('origin must be { x, y }');
  for (const flag of ['readRepo', 'suggest']) if (typeof p[flag] !== 'boolean') throw invalidParams(`${flag} must be a boolean`);
  return {
    question,
    harness: harness as AskSelectionParams['harness'],
    model: optionalStringParam(p, 'model'),
    role: optionalStringParam(p, 'role'),
    zoneId: p.zoneId === null ? null : stringParam(p, 'zoneId'),
    readRepo: p.readRepo as boolean,
    suggest: p.suggest as boolean,
    diagram,
    objects: objectsParam(p, diagram),
    origin,
    picturePath: stringParam(p, 'picturePath'),
    ...(p.pictureScale === undefined ? {} : { pictureScale: scaleParam(p) }),
    anchor,
    note: placeParam(p, 'note'),
    tile: placeParam(p, 'tile'),
    cols: dimensionParam(p, 'cols'),
    rows: dimensionParam(p, 'rows'),
  };
}

/** What a pending or answered ask keeps, until its agent goes. */
interface AskRecord {
  question: string;
  objects: AskSelectionParams['objects'];
  origin: { x: number; y: number };
  anchor: string;
  note: BoardPlace;
  tile: BoardPlace;
  /** The folder its picture and diagram are in. */
  dir: string;
}

interface AskRow {
  session_id: string;
  ask: string;
  note_id: string | null;
}

export interface SelectionAskOptions {
  db: DatabaseSync;
  /** Where each ask's picture and diagram are kept, a folder each. */
  dir: string;
  /** Takes a picture the app left in `images/incoming` into the image store (`image.import`), and where it is kept. */
  images: { importFile(path: string): ImageRef; filePath(ref: ImageRef): string };
  /** Starts the agent, as the user would. */
  spawn(params: SpawnAgentParams, place: FolderPlace): Promise<Agent>;
  agent(sessionId: string): Agent | undefined;
  /** The agent's final message from the turn it last finished, if it has finished one. */
  finalMessage(sessionId: string): string | undefined;
  /** The repo a zone's agents are cut from: its own, or its default repo; null for none. */
  zoneRepo(zoneId: string): string | null;
  /** The daemon's own methods: the note, its arrow and the tile's move are made as the board makes them. */
  call: DaemonCall;
  log(message: string): void;
}

export interface SelectionAsks {
  handlers<Context>(): RpcHandlers<SelectionAskMethods, Context>;
  /** The agent's turn finished with `finalMessage`: its first answer goes on the board. */
  finished(sessionId: string, finalMessage: string): Promise<void>;
  /** The agent is going: its ask, picture and diagram go too. */
  forget(sessionId: string): void;
}

export function createSelectionAsks(options: SelectionAskOptions): SelectionAsks {
  const { db } = options;
  const insert = db.prepare('INSERT INTO selection_asks (session_id, ask) VALUES (?, ?)');
  const selectOne = db.prepare('SELECT * FROM selection_asks WHERE session_id = ?');
  const setNote = db.prepare('UPDATE selection_asks SET note_id = ? WHERE session_id = ? AND note_id IS NULL');
  const remove = db.prepare('DELETE FROM selection_asks WHERE session_id = ?');
  /** Answers being put on the board, so a second Stop before the first is placed makes no second note. */
  const placing = new Set<string>();

  const ask = async (params: AskSelectionParams): Promise<Agent> => {
    const ref = options.images.importFile(params.picturePath);
    if (ref.ext !== 'png') throw invalidParams('the picture of a selection must be a PNG');
    const dir = join(options.dir, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const files = { picture: join(dir, 'selection.png'), diagram: join(dir, 'selection.json') };
      copyFileSync(options.images.filePath(ref), files.picture);
      writeFileSync(files.diagram, `${JSON.stringify(params.diagram, null, 2)}\n`, { mode: 0o600 });
      const repo = params.readRepo && params.zoneId !== null ? options.zoneRepo(params.zoneId) : null;
      // No worktree and no branch: the user's checkout, to read and change nothing in, or else the ask's own folder.
      const place = repo === null ? { cwd: dir, repoRoot: dir, readOnly: false } : { cwd: repo, repoRoot: repo, readOnly: true };
      const agent = await options.spawn(
        {
          zoneId: params.tile.zoneId,
          position: { x: params.tile.x, y: params.tile.y },
          harness: params.harness,
          model: params.model,
          role: params.role?.trim() || DEFAULT_ASK_ROLE,
          name: `Ask: ${cutText(params.question.split('\n', 1)[0]!, 40)}`,
          prompt: selectionPrompt({ ...params, readRepo: repo !== null }, files),
          cols: params.cols,
          rows: params.rows,
        },
        place,
      );
      // Where its tile was put, which the board may have nudged from where it was asked for.
      const tile = agent.position === null ? params.tile : { zoneId: agent.zoneId, x: agent.position.x, y: agent.position.y };
      const record: AskRecord = { question: params.question, objects: params.objects, origin: params.origin, anchor: params.anchor, note: params.note, tile, dir };
      insert.run(agent.sessionId, JSON.stringify(record));
      // A quick agent may have answered before it was known to be asked: its answer goes on the board now.
      const said = options.finalMessage(agent.sessionId);
      if (said !== undefined) void finished(agent.sessionId, said);
      return agent;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  };

  const answer = async (sessionId: string, record: AskRecord, finalMessage: string) => {
    const agent = options.agent(sessionId);
    if (agent === undefined) return;
    const { text, suggestions } = parseAnswer(finalMessage, record);
    const body = cutText(text === '' ? '(No answer.)' : text, MAX_STICKY_TEXT);
    const size = agentNoteSize(body);
    const data = agentNoteData({ ...agentNoteAuthor(agent), role: roleLabel(agent) }, body, { asked: cutText(record.question, MAX_QUESTION), ...(suggestions.length > 0 ? { suggestions } : {}) });
    const note = await options.call('item.create', { kind: 'agent-note', zoneId: record.note.zoneId, x: record.note.x, y: record.note.y, ...size, data: { ...data } });
    setNote.run(note.id, sessionId);
    const anchor = record.objects[record.anchor];
    if (anchor !== undefined) {
      // The object may have gone meanwhile: the note stands without its arrow.
      await options
        .call('connector.create', { from: { ...anchor, side: 'right' }, to: { type: 'item', id: note.id, side: 'left' } })
        .catch((error: unknown) => options.log(`selection ask ${sessionId}: no arrow to its answer: ${(error as Error).message}`));
    }
    // Its tile goes under the note, unless the user has moved it since it started.
    const now = options.agent(sessionId);
    const unmoved = now !== undefined && now.zoneId === record.tile.zoneId && now.position?.x === record.tile.x && now.position?.y === record.tile.y;
    if (unmoved && record.tile.zoneId === record.note.zoneId) {
      await options
        .call('agent.move', { sessionId, zoneId: record.note.zoneId, x: record.note.x, y: record.note.y + size.height + NOTE_TILE_GAP })
        .catch((error: unknown) => options.log(`selection ask ${sessionId}: its tile stayed put: ${(error as Error).message}`));
    }
  };

  async function finished(sessionId: string, finalMessage: string): Promise<void> {
    const row = selectOne.get(sessionId) as AskRow | undefined;
    if (row === undefined || row.note_id !== null || placing.has(sessionId)) return;
    placing.add(sessionId);
    try {
      await answer(sessionId, JSON.parse(row.ask) as AskRecord, finalMessage);
    } catch (error) {
      options.log(`selection ask ${sessionId}: its answer could not be put on the board: ${(error as Error).message}`);
    } finally {
      placing.delete(sessionId);
    }
  }

  return {
    handlers<Context>(): RpcHandlers<SelectionAskMethods, Context> {
      return { 'selection.ask': (params) => ask(askParams(params)) };
    },
    finished,
    forget(sessionId) {
      const row = selectOne.get(sessionId) as AskRow | undefined;
      if (row === undefined) return;
      remove.run(sessionId);
      rmSync((JSON.parse(row.ask) as AskRecord).dir, { recursive: true, force: true });
    },
  };
}
