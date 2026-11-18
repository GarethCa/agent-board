// Crew prefabs agents draft for the user, backed by `prefab_drafts`: any agent may draft one, checked as an imported
// `.crew.json` file is, and the user opens it on the prefab's board to save or delete. A draft never enters the library
// by itself, and drafting starts, saves or changes nothing else. The user may ask an agent to draft one from a
// description: one on the board by a message, or a new one, which closes once its draft is opened.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { parsePrefab, prefabFile } from './crew-prefabs.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import { HIDDEN } from './prefab-paths.ts';
import {
  MAX_ASSUMPTION_LENGTH,
  MAX_CREW_DESCRIPTION_LENGTH,
  MAX_DRAFT_ASSUMPTIONS,
  MAX_PREFAB_DRAFTS,
  MAX_PREFAB_FILE_BYTES,
  type CrewPrefab,
  type DaemonEvent,
  type DaemonMethods,
  type OrchestratorSpawned,
  type OrchestratorSpawnParams,
  type PrefabAssumption,
  type PrefabDraft,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type DraftMethods = Pick<DaemonMethods, 'board.draftPrefab' | 'prefabDraft.list' | 'prefabDraft.open' | 'prefabDraft.remove' | 'prefabDraft.describe'>;

/** A new drafter: Claude on Sonnet, named for what it does. */
const NEW_DRAFTER = { harness: 'claude', model: 'sonnet', name: 'Prefab drafter', description: 'Drafts a crew prefab from your description' } as const;

interface DraftRow {
  id: string;
  body: string;
  assumptions: string;
  drafter_tile: string;
  drafter_name: string;
  closes_drafter: number;
  created_at: string;
}

export interface PrefabDraftOptions<Context> extends BoardCallerSources {
  broadcast(event: DaemonEvent): void;
  /** Starts an agent as `orchestrator.spawn` does, for the user on `connection`. */
  spawn(params: OrchestratorSpawnParams, connection: Context): Promise<OrchestratorSpawned>;
  /** Types a message to an agent as `orchestrator.send` does, for the user on `connection`. */
  send(params: { sessionId: string; text: string }, connection: Context): Promise<unknown>;
  /** Closes an agent as `orchestrator.close` does, its unsaved work kept, for the user on `connection`. */
  close(params: { sessionId: string }, connection: Context): Promise<unknown>;
}

/** The ids an assumption may be about: the prefab's members, inputs and loop gates. */
const graphIds = (prefab: CrewPrefab): Set<string> => new Set([...prefab.members, ...(prefab.inputs ?? []), ...(prefab.gates ?? [])].map((node) => node.id));

/** One line of a drafter's assumptions, as it gave it: a line, or `{ text, about }`. */
function assumption(raw: unknown, ids: ReadonlySet<string>): PrefabAssumption {
  const fields = typeof raw === 'string' ? { text: raw } : raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (fields === undefined || typeof fields.text !== 'string') throw invalidParams('an assumption is a line of text, or an object of text and about');
  const text = fields.text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text === '') throw invalidParams('an assumption needs some text');
  if (text.length > MAX_ASSUMPTION_LENGTH) throw invalidParams(`an assumption is at most ${MAX_ASSUMPTION_LENGTH} characters`);
  if (HIDDEN.test(text)) throw invalidParams('an assumption has no control characters');
  const about = fields.about;
  if (about === undefined || about === null) return { text, about: null };
  if (typeof about !== 'string' || !ids.has(about)) throw invalidParams(`an assumption is about one of the prefab's members, inputs or loop gates, by its id: not ${JSON.stringify(about).slice(0, 60)}`);
  return { text, about };
}

/** What a drafter's first message (or its message) says: how to draft, then the user's description. */
export function draftingPrompt(description: string, started: boolean): string {
  return [
    'Draft a crew prefab for the user, from their description below.',
    "1. Read the roles and prefabs they have: `agent-board roles`, `agent-board prefab ls`, and `agent-board prefab show <name>` for one whole, as its .crew.json file.",
    '2. Write one .crew.json file (version 2) for the crew they describe, outside any repo (under $TMPDIR).',
    "3. Run `agent-board prefab draft <file> --assumed '<line>'` (or the prefab_draft tool), with one --assumed for each thing you chose that they didn't say; start a line with a member's, input's or loop gate's id in brackets (`[reviewer] …`) when it is about that one. If it is refused, fix the file and run it again.",
    "Drafting changes nothing: don't save, start or change anything else. The user opens the draft on the prefab's board, and saves it if they like it.",
    started ? 'You close once the user opens your draft.' : 'Then carry on with your own work.',
    '',
    'Their description:',
    description,
  ].join('\n');
}

export function createPrefabDrafts(db: DatabaseSync) {
  const selectAll = db.prepare('SELECT * FROM prefab_drafts ORDER BY created_at, id');
  const selectOne = db.prepare('SELECT * FROM prefab_drafts WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM prefab_drafts');
  const insert = db.prepare('INSERT INTO prefab_drafts (id, body, assumptions, drafter_tile, drafter_name, closes_drafter) VALUES (?, ?, ?, ?, ?, ?) RETURNING *');
  const remove = db.prepare('DELETE FROM prefab_drafts WHERE id = ?');
  const isDrafter = db.prepare('SELECT 1 FROM prefab_drafters WHERE session_id = ?');
  const addDrafter = db.prepare('INSERT OR IGNORE INTO prefab_drafters (session_id) VALUES (?)');
  const dropDrafter = db.prepare('DELETE FROM prefab_drafters WHERE session_id = ?');
  const noLongerCloses = db.prepare('UPDATE prefab_drafts SET closes_drafter = 0 WHERE drafter_tile = ?');

  /** A row as a draft: read with the file's own parser, as a library row is, so a later release may refuse one. */
  const draftOf = (row: DraftRow): PrefabDraft => ({
    id: row.id,
    prefab: parsePrefab(row.body),
    assumptions: JSON.parse(row.assumptions) as PrefabAssumption[],
    drafter: { tileId: row.drafter_tile, name: row.drafter_name },
    closesDrafter: row.closes_drafter === 1,
    createdAt: row.created_at,
  });
  const rowNamed = (id: string): DraftRow => {
    const row = selectOne.get(id) as DraftRow | undefined;
    if (row === undefined) throw invalidParams(`there is no prefab draft ${id}: it was saved or deleted`);
    return row;
  };

  return {
    handlers<Context extends BoardConnection>(options: PrefabDraftOptions<Context>): RpcHandlers<DraftMethods, Context> {
      /** Closes a drafter started for its draft, once: it is done, and the draft is the user's now. */
      const doneDrafting = async (tile: string, connection: Context) => {
        noLongerCloses.run(tile);
        dropDrafter.run(tile);
        const agent = options.agents.get(tile);
        if (agent !== undefined && agent.endedAt === null) await options.close({ sessionId: tile }, connection);
      };
      return {
        'board.draftPrefab': (params, connection) => {
          const fields = paramsObject(params);
          const who = boardCaller(options, stringParam(fields, 'token'), connection);
          const text = stringParam(fields, 'text');
          if (Buffer.byteLength(text) > MAX_PREFAB_FILE_BYTES) throw invalidParams('the draft is too big for a crew prefab file');
          // Checked as an imported file is, and stored as the library stores one: every field written out.
          const prefab = parsePrefab(text);
          const given = fields.assumptions ?? [];
          if (!Array.isArray(given)) throw invalidParams('assumptions must be a list');
          if (given.length > MAX_DRAFT_ASSUMPTIONS) throw invalidParams(`a draft carries at most ${MAX_DRAFT_ASSUMPTIONS} assumptions`);
          const ids = graphIds(prefab);
          const assumptions = given.map((each) => assumption(each, ids));
          if ((count.get() as { n: number }).n >= MAX_PREFAB_DRAFTS) {
            throw invalidParams(`the user has ${MAX_PREFAB_DRAFTS} prefab drafts waiting already: ask them to open or delete some in Settings › Prefabs › Drafts`);
          }
          // Only an agent the user started to draft closes as its draft opens, and only from its own live session.
          const agent = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
          const closes = agent !== undefined && isOwnLiveSession(agent, who.sessionId) && isDrafter.get(agent.sessionId) !== undefined;
          const row = insert.get(`draft:${randomUUID()}`, prefabFile(prefab), JSON.stringify(assumptions), who.tileId, who.name, closes ? 1 : 0) as unknown as DraftRow;
          const draft = draftOf(row);
          options.broadcast({ type: 'prefabDraft.added', draft });
          return draft;
        },
        'prefabDraft.list': () => {
          const drafts: PrefabDraft[] = [];
          const unreadable: { id: string; reason: string }[] = [];
          for (const row of selectAll.all() as unknown as DraftRow[]) {
            try {
              drafts.push(draftOf(row));
            } catch (error) {
              unreadable.push({ id: row.id, reason: (error as Error).message });
            }
          }
          return { drafts, unreadable };
        },
        'prefabDraft.open': async (params, connection) => {
          const fields = paramsObject(params);
          const draft = draftOf(rowNamed(stringParam(fields, 'id')));
          if (!draft.closesDrafter) return draft;
          await doneDrafting(draft.drafter.tileId, connection);
          return { ...draft, closesDrafter: false };
        },
        'prefabDraft.remove': async (params, connection) => {
          const id = stringParam(paramsObject(params), 'id');
          const row = selectOne.get(id) as DraftRow | undefined;
          if (row === undefined || remove.run(id).changes === 0) throw invalidParams(`there is no prefab draft ${id}: it was saved or deleted`);
          options.broadcast({ type: 'prefabDraft.removed', id });
          // Deleted unopened, a drafter started for it is done too.
          if (row.closes_drafter === 1) await doneDrafting(row.drafter_tile, connection);
          return null;
        },
        'prefabDraft.describe': async (params, connection) => {
          const fields = paramsObject(params);
          const description = stringParam(fields, 'description').trim();
          if (description === '') throw invalidParams('say what the crew should do, and how');
          if (description.length > MAX_CREW_DESCRIPTION_LENGTH) throw invalidParams(`a description is at most ${MAX_CREW_DESCRIPTION_LENGTH} characters`);
          const drafter = optionalStringParam(fields, 'drafter');
          if (drafter !== undefined) {
            const agent = options.agents.get(drafter);
            if (agent === undefined || agent.endedAt !== null) throw invalidParams('that agent is not on the board, running: pick another, or a new one');
            await options.send({ sessionId: agent.sessionId, text: draftingPrompt(description, false) }, connection);
            return { sessionId: agent.sessionId, name: agent.name, started: false };
          }
          const zoneId = optionalStringParam(fields, 'zoneId');
          if (zoneId === undefined) throw invalidParams('name the zone to start the drafter in, or pick an agent on the board');
          const agent = await options.spawn({ ...NEW_DRAFTER, zoneId, prompt: draftingPrompt(description, true) }, connection);
          addDrafter.run(agent.sessionId);
          return { sessionId: agent.sessionId, name: agent.name, started: true };
        },
      };
    },
  };
}
