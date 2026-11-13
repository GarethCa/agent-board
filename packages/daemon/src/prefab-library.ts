// The app's crew prefab library, one for every board: the built-ins, and the prefabs saved or imported, backed by
// `crew_prefabs`. A crew starts from one through `orchestrator.spawn`, so it is scoped, checked and logged as any agent
// an orchestrator starts.
import type { DatabaseSync } from 'node:sqlite';
import type { BoardConnection } from './board.ts';
import { BUILT_IN_PREFABS, parsePrefab, prefabFile } from './crew-prefabs.ts';
import type { ActivityEntry, OrchestratorAccess } from './orchestrators.ts';
import { invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_CREW_DEPTH,
  MAX_REVIEW_CAP,
  ORCHESTRATE_SETTING,
  REVIEWER_ROLES,
  type CrewPrefab,
  type DaemonMethods,
  type LibraryPrefab,
  type OrchestratorSpawnParams,
  type OrchestratorSpawned,
  type PrefabMember,
  type PrefabStarted,
  type Zone,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { shellQuote } from './shell-words.ts';

type PrefabMethods = Pick<DaemonMethods, 'orchestrator.prefabs' | 'orchestrator.savePrefab' | 'orchestrator.removePrefab' | 'orchestrator.startPrefab'>;

interface PrefabRow {
  name: string;
  body: string;
  edited_at: string;
}

export interface PrefabLibraryOptions<Context> {
  access: OrchestratorAccess;
  /** Starts an agent as `orchestrator.spawn` does, for the caller on `connection`. */
  spawn(params: { token?: string } & OrchestratorSpawnParams, connection: Context): Promise<OrchestratorSpawned>;
  /** How deep in a crew the agent `sessionId` is: 0 for one the user started. */
  depth(sessionId: string): number;
  zones(): Zone[];
  /** Starts the crew's loop around the agent `builder`, if the prefab has reviewers at the hand-off: its id, else null. */
  startCrew(prefab: CrewPrefab, builder: string, startedBy: string | null, prompt: string): string | null;
}

const builtIn = (prefab: CrewPrefab): LibraryPrefab => ({ ...prefab, builtIn: true, editedAt: null });
const asciiFolded = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The command that starts `member` as the prefab says, a reviewer on `builder`'s branch. */
function memberCommand(member: PrefabMember, builder: PrefabMember | undefined): string {
  const reviews = REVIEWER_ROLES.includes(member.role as never) && builder !== undefined;
  // Each value as one shell word: a shared file's names and models are anyone's text, and the lead types this line.
  const flags = [
    reviews ? ` --base <${builder.id}'s ref>` : '',
    member.role === null ? '' : ` --role ${shellQuote(member.role)}`,
    ` --harness ${member.harness}`,
    member.model === null ? '' : ` --model ${shellQuote(member.model)}`,
    member.effort === null ? '' : ` --effort ${member.effort}`,
    member.name === null ? '' : ` --name ${shellQuote(member.name)}`,
  ].join('');
  return `agent-board new${flags} -- '<its task>'`;
}

/** A member as one line of a lead's crew: the command that starts it. */
function rosterLine(member: PrefabMember, builder: PrefabMember | undefined): string {
  return `- ${member.id}: \`${memberCommand(member, builder)}\``;
}

/**
 * The member whose branch the crew's reviewers review: the one that starts on the prompt, or, in a crew with a lead, the
 * first member the lead starts that isn't a reviewer.
 */
function crewBuilder(prefab: CrewPrefab): PrefabMember | undefined {
  const lead = prefab.members.some((member) => member.starts === 'lead');
  if (!lead) return prefab.members.find((member) => member.starts === 'prompt');
  return prefab.members.find((member) => member.starts === 'lead' && !REVIEWER_ROLES.includes(member.role as never));
}

/** What a lead's first message adds after the task: the crew it may start, and when to stop. */
function leadBrief(prefab: CrewPrefab): string {
  const crew = prefab.members.filter((member) => member.starts === 'lead');
  const builder = crewBuilder(prefab);
  return [
    `You lead a crew from the ${prefab.name} prefab. Start each member when its work is ready, with the command shown:`,
    ...crew.map((member) => rosterLine(member, builder)),
    `Run at most ${prefab.roundLimit} review ${prefab.roundLimit === 1 ? 'round' : 'rounds'}, then stop and ask the user.`,
  ].join('\n');
}

export interface PrefabLibrary {
  handlers<Context extends BoardConnection>(options: PrefabLibraryOptions<Context>): RpcHandlers<PrefabMethods, Context>;
}

export function createPrefabLibrary(db: DatabaseSync): PrefabLibrary {
  const selectAll = db.prepare('SELECT name, body, edited_at FROM crew_prefabs ORDER BY name');
  const selectOne = db.prepare('SELECT name, body, edited_at FROM crew_prefabs WHERE name = ?');
  const insert = db.prepare('INSERT INTO crew_prefabs (name, body) VALUES (?, ?) RETURNING name, body, edited_at');
  const update = db.prepare(
    "UPDATE crew_prefabs SET name = ?, body = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? RETURNING name, body, edited_at",
  );
  const remove = db.prepare('DELETE FROM crew_prefabs WHERE name = ?');

  const saved = (row: PrefabRow): LibraryPrefab => ({ ...parsePrefab(row.body), builtIn: false, editedAt: row.edited_at });
  /** A saved row, or why it can't be read: a later release may read stricter than the one that saved it. */
  const readRow = (row: PrefabRow): LibraryPrefab | { name: string; reason: string } => {
    try {
      return saved(row);
    } catch (error) {
      return { name: row.name, reason: (error as Error).message };
    }
  };
  const builtInNamed = (name: string) => BUILT_IN_PREFABS.find((prefab) => asciiFolded(prefab.name) === asciiFolded(name.trim()));

  /** The prefab named `name`, in any case: a built-in, else a saved one. */
  const get = (name: string): LibraryPrefab | undefined => {
    const own = builtInNamed(name);
    if (own !== undefined) return builtIn(own);
    const row = selectOne.get(name.trim()) as PrefabRow | undefined;
    if (row === undefined) return undefined;
    const read = readRow(row);
    if ('reason' in read) throw invalidParams(`the crew prefab ${read.name} can't be read (${read.reason}): remove it, or import it again`);
    return read;
  };

  /** Throws `outOfScope` unless `me` may change the library, which reaches every board. */
  const mayChange = (access: OrchestratorAccess, me: Parameters<OrchestratorAccess['scopeText']>[0]) => {
    if (me.orchestrate === 'board') return;
    throw new RpcMethodError(
      BOARD_ERROR.outOfScope,
      `the crew prefab library reaches every board, so it is for the user or an orchestrator of the whole board; your scope is ${access.scopeText(me)}`,
    );
  };

  return {
    handlers<Context extends BoardConnection>({ access, spawn, depth, zones, startCrew }: PrefabLibraryOptions<Context>): RpcHandlers<PrefabMethods, Context> {
      const logged = (name: string) => ({ id: `prefab:${name}`, name });
      /** The prefab `name`, once `me` may start it in `zoneId` (its own zone without), else why not. */
      const startable = (me: Parameters<OrchestratorAccess['scopeText']>[0], name: string, zoneId: string | undefined): LibraryPrefab => {
        const prefab = get(name);
        if (prefab === undefined) throw invalidParams(`the library has no crew prefab named ${name.trim()}: agent-board prefab ls lists them`);
        const ledCrew = prefab.members.some((member) => member.starts === 'lead');
        // The lead is a level of the crew, and its members one more: both must fit under the deepest a crew goes.
        const levels = ledCrew ? 2 : 1;
        if (me.agent !== null && depth(me.agent.sessionId) + levels > MAX_CREW_DEPTH - 1) {
          throw new RpcMethodError(
            BOARD_ERROR.outOfScope,
            `${prefab.name} needs ${levels} free ${levels === 1 ? 'level' : 'levels'} of crew depth below you, and a crew goes ${MAX_CREW_DEPTH} deep: ask the agent that started you to start it`,
          );
        }
        // A lead in a zone that doesn't let its agents orchestrate could start none of its crew: said now, not found later.
        const zone = zones().find((each) => each.id === (zoneId ?? me.zoneId));
        if (ledCrew && zone !== undefined && !zone.agentsOrchestrate) {
          throw invalidParams(
            `${zone.name} doesn't let its agents orchestrate, so ${prefab.name}'s lead could start none of its crew: turn on ${ORCHESTRATE_SETTING}, or start it in another zone`,
          );
        }
        return prefab;
      };
      return {
        'orchestrator.prefabs': (params, connection) => {
          access.caller('orchestrator.prefabs', paramsObject(params), connection);
          const rows = (selectAll.all() as unknown as PrefabRow[]).map(readRow);
          return {
            prefabs: [...BUILT_IN_PREFABS.map(builtIn), ...rows.filter((row): row is LibraryPrefab => !('reason' in row))],
            unreadable: rows.filter((row): row is { name: string; reason: string } => 'reason' in row),
          };
        },
        'orchestrator.savePrefab': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.savePrefab', fields, connection);
          const entry: ActivityEntry = { detail: '' };
          return access.logged(me, 'save-prefab', entry, () => {
            const prefab = parsePrefab(stringParam(fields, 'text'));
            entry.detail = prefab.name;
            entry.on = logged(prefab.name);
            mayChange(access, me);
            if (builtInNamed(prefab.name) !== undefined) {
              throw invalidParams(`${prefab.name} is a built-in prefab: save your copy under a name of its own`);
            }
            const body = prefabFile(prefab);
            const there = selectOne.get(prefab.name) as PrefabRow | undefined;
            if (there === undefined) return saved(insert.get(prefab.name, body) as unknown as PrefabRow);
            if (optionalBooleanParam(fields, 'replace') !== true) {
              throw invalidParams(`the library has a crew prefab named ${there.name} already: replace it, or save under another name`);
            }
            return saved(update.get(prefab.name, body, there.name) as unknown as PrefabRow);
          });
        },
        'orchestrator.removePrefab': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.removePrefab', fields, connection);
          const name = typeof fields.name === 'string' ? fields.name.trim() : '';
          const entry: ActivityEntry = { detail: name, on: logged(name) };
          return access.logged(me, 'remove-prefab', entry, () => {
            mayChange(access, me);
            stringParam(fields, 'name');
            if (builtInNamed(name) !== undefined) throw invalidParams(`${name} is a built-in prefab: it can't be removed`);
            if (remove.run(name).changes === 0) throw invalidParams(`the library has no crew prefab named ${name}`);
            return null;
          });
        },
        'orchestrator.startPrefab': async (params, connection): Promise<PrefabStarted> => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.startPrefab', fields, connection);
          const zoneId = optionalStringParam(fields, 'zoneId');
          let prefab: LibraryPrefab;
          try {
            prefab = startable(me, stringParam(fields, 'name'), zoneId);
            // For this crew alone: the prefab keeps its own.
            const roundLimit = fields.roundLimit;
            if (roundLimit !== undefined) {
              if (typeof roundLimit !== 'number' || !Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > MAX_REVIEW_CAP) {
                throw invalidParams(`the round limit is a whole number from 1 to ${MAX_REVIEW_CAP}`);
              }
              prefab = { ...prefab, roundLimit };
            }
          } catch (error) {
            // Refused before any agent is asked for: logged as a refused start, as `spawn` logs its own refusals.
            const name = typeof fields.name === 'string' ? fields.name.trim() : '';
            await access.logged(me, 'spawn', { detail: `crew prefab ${name}` }, () => Promise.reject(error)).catch(() => {});
            throw error;
          }
          const first = prefab.members.find((member) => member.starts === 'prompt')!;
          const ledCrew = prefab.members.some((member) => member.starts === 'lead');
          const prompt = optionalStringParam(fields, 'prompt') ?? '';
          const firstPrompt = ledCrew ? [prompt.trim(), leadBrief(prefab)].filter(Boolean).join('\n\n') : prompt;
          const token = optionalStringParam(fields, 'token');
          const repo = optionalStringParam(fields, 'repo');
          const issueId = optionalStringParam(fields, 'issueId');
          const description = optionalStringParam(fields, 'description');
          const agent = await spawn(
            {
              ...(token === undefined ? {} : { token }),
              ...(zoneId === undefined ? {} : { zoneId }),
              ...(repo === undefined ? {} : { repo }),
              ...(issueId === undefined ? {} : { issueId }),
              ...(description === undefined ? {} : { description }),
              prompt: firstPrompt,
              harness: first.harness,
              ...(first.model === null ? {} : { model: first.model }),
              ...(first.effort === null ? {} : { effort: first.effort }),
              ...(first.role === null ? {} : { role: first.role }),
              ...(first.name === null ? {} : { name: first.name }),
              ...(first.template === null ? {} : { template: first.template }),
            },
            connection,
          );
          return {
            prefab: prefab.name,
            started: [{ ...agent, member: first.id }],
            crew: startCrew(prefab, agent.sessionId, me.agent?.sessionId ?? null, prompt),
            // The crew starts its reviewers at the hand-off, and a lead its own crew: each with the command that starts it.
            later: prefab.members.flatMap((member) =>
              member.starts === 'prompt' ? [] : [{ member: member.id, starts: member.starts, command: memberCommand(member, crewBuilder(prefab)) }],
            ),
          };
        },
      };
    },
  };
}
