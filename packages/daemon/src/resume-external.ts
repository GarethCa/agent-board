// Resuming an external session in agent-board: it is adopted as an agent under the same session id, its tile
// taking the external tile's place, so it gets a terminal, live state and flow edges like any agent.
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AdoptSpec, AgentHost } from './agents.ts';
import { connectorRepointer } from './connectors.ts';
import { runGit } from './git.ts';
import { sessionPlace, type ExternalSessionHost, type ResumableSession } from './external-sessions.ts';
import { dimensionParam, invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import {
  AGENT_ERROR,
  LIVE_ELSEWHERE_WARNING,
  type DaemonEvent,
  type DaemonMethods,
  type ExternalResumePlan,
  type ExternalResumeWhere,
  type TilePosition,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { frontZ, optionalPlaceParam } from './tile-position.ts';

type ResumeMethods = Pick<DaemonMethods, 'external.resumePlan' | 'external.resume'>;

export interface ExternalResumeOptions {
  db: DatabaseSync;
  external: Pick<ExternalSessionHost, 'resumable' | 'adopted'>;
  agents: Pick<AgentHost, 'adopt'>;
  broadcast(event: DaemonEvent): void;
}

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/** How long after a session reported its end its harness may still be finishing its transcript. */
const END_WRITE_GRACE_MS = 5_000;

/**
 * Whether the session may still be running in another terminal: it never reported its end, or its transcript was
 * written well after it did (resumed there with the global hooks off).
 */
function liveElsewhere(session: ResumableSession): boolean {
  if (session.endedAt === null) return true;
  if (session.transcriptPath === null) return false;
  const written = statSync(session.transcriptPath, { throwIfNoEntry: false })?.mtimeMs;
  return written !== undefined && written > Date.parse(session.endedAt) + END_WRITE_GRACE_MS;
}

/** The git checkout the session is in now: found from its folder, else its worktree or repo while they remain. */
async function checkout(session: ResumableSession): Promise<ExternalResumePlan['repo']> {
  const probe = [session.cwd, session.worktree, session.repoRoot].find((path) => path !== null && isDirectory(path));
  if (probe == null) return null;
  const place = await sessionPlace(probe);
  if (place.worktree === null || place.repoRoot === null) return null;
  // Its own worktree gone, its branch may still be in the repo.
  const branch = probe === session.repoRoot && session.worktree !== session.repoRoot ? session.branch : place.branch;
  return { root: place.repoRoot, worktree: place.worktree, branch, main: place.worktree === place.repoRoot };
}

/** What a new worktree for the session is cut from: its branch, or the commit a detached session is on. */
async function baseOf(repo: NonNullable<ExternalResumePlan['repo']>): Promise<{ branch: string } | { commit: string }> {
  if (repo.branch !== null) return { branch: repo.branch };
  const head = await runGit(repo.worktree, ['rev-parse', 'HEAD']);
  if (!head.ok) throw invalidParams(`can't tell what commit ${repo.worktree} is on: ${head.stderr}`);
  return { commit: head.stdout };
}

async function plan(session: ResumableSession): Promise<ExternalResumePlan> {
  return {
    cwd: session.cwd,
    cwdExists: isDirectory(session.cwd),
    repo: await checkout(session),
    liveElsewhere: liveElsewhere(session),
  };
}

/** A folder of the user's, as an in-place agent works in it: its worktree, repo and branch, or none outside git. */
async function inPlace(cwd: string): Promise<AdoptSpec['place']> {
  const place = await sessionPlace(cwd);
  return {
    kind: 'in-place',
    cwd,
    worktree: place.worktree ?? cwd,
    repoRoot: place.repoRoot ?? place.worktree ?? cwd,
    branch: place.branch ?? '',
  };
}

function whereParam(fields: Record<string, unknown>): ExternalResumeWhere {
  const where = fields.where;
  if (where === 'here' || where === 'new-worktree') return where;
  if (typeof where === 'object' && where !== null) return { folder: stringParam(paramsObject(where), 'folder') };
  throw invalidParams("where must be 'here', 'new-worktree' or { folder }");
}

/** The `external.resumePlan` and `external.resume` RPC handlers. */
export function externalResumeHandlers<Context>(options: ExternalResumeOptions): RpcHandlers<ResumeMethods, Context> {
  const { db, external, agents } = options;
  const repointConnectors = connectorRepointer(db, options.broadcast);
  /** Sessions being adopted, so a second click doesn't start them twice. */
  const adopting = new Set<string>();

  const requireSession = (id: string): ResumableSession => {
    const session = external.resumable(id);
    if (session === undefined) throw invalidParams(`no external session ${id}`);
    return session;
  };

  return {
    'external.resumePlan': (params) => plan(requireSession(stringParam(paramsObject(params), 'id'))),

    'external.resume': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const where = whereParam(fields);
      const force = optionalBooleanParam(fields, 'force') ?? false;
      const size = { cols: dimensionParam(fields, 'cols'), rows: dimensionParam(fields, 'rows') };
      const given = optionalPlaceParam(fields);
      if (adopting.has(id)) throw invalidParams('it is already being resumed');
      adopting.add(id);
      try {
        const session = requireSession(id);
        const now = await plan(session);
        if (now.liveElsewhere && !force) {
          throw new RpcMethodError(AGENT_ERROR.liveElsewhere, LIVE_ELSEWHERE_WARNING);
        }
        let place: AdoptSpec['place'];
        if (where === 'here') {
          if (!now.cwdExists) throw invalidParams(`${session.cwd} is gone: resume it in a new worktree or another folder`);
          place = await inPlace(session.cwd);
        } else if (where === 'new-worktree') {
          if (now.repo === null) throw invalidParams(`${session.cwd} is not in a git repo, so it can't have a new worktree`);
          place = { kind: 'new-worktree', repoRoot: now.repo.root, base: await baseOf(now.repo), folder: session.folder };
        } else {
          if (!isAbsolute(where.folder) || !isDirectory(where.folder)) {
            throw invalidParams(`${where.folder} is not a folder`);
          }
          place = await inPlace(where.folder);
        }
        // Where its tile is, else where the board drew it (slotted in its zone).
        const position: TilePosition | null = session.position ?? (given === undefined ? null : { ...given, z: frontZ(db) });
        if (session.zoneId === null && position === null) throw invalidParams('a session in no zone needs a position on the board');
        const agent = await agents.adopt({
          sessionId: session.sessionId,
          harness: session.harness,
          name: session.name,
          description: session.description,
          zoneId: session.zoneId,
          position,
          transcriptPath: session.transcriptPath,
          place,
          size,
        });
        repointConnectors({ type: 'external', id }, { type: 'agent', id: agent.sessionId });
        external.adopted(id);
        return agent;
      } finally {
        adopting.delete(id);
      }
    },
  };
}
