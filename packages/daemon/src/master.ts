import { mkdirSync } from 'node:fs';
import type { FolderPlace } from './agent-spawns.ts';
import { dimensionParam, invalidParams, optionalStringParam, paramsObject } from './params.ts';
import { TILE_SLOT, type Agent, type DaemonMethods, type Harness, type SpawnAgentParams, type Zone } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type MasterMethods = Pick<DaemonMethods, 'master.start'>;

/** How far left of the zones the master's tile goes, past a tile's width: clear of every zone's tab and edge. */
const MASTER_MARGIN = 80;

/**
 * The board master's first message (ADR-0019): what it is for, how it routes, and what it never does. Plain text, as an
 * orchestrator's prompt must be: no leading `!` or `/command`, no control characters.
 */
const MASTER_PROMPT = `You are the board master: the one agent on this board the user asks for work. You have orchestrator scope over the whole board. Run \`agent-board --help\` and \`agent-board help orchestrate\` once to learn the commands.

Your job:
- Route each request to the right zone's orchestrator. Find the zone from the repo, issue or wording with \`agent-board tree\`, or ask the user when it is unclear. If the zone has a live orchestrator, \`agent-board send\` it the request. If it has none, start one there with \`agent-board new --zone <zone> --role orchestrator <request>\`. Don't do a zone's work yourself.
- An orchestrator you start can start agents only while its zone lets agents orchestrate (\`agent-board show <zone>\` says whether agents orchestrate there). When that is off, don't start one: tell the user with \`agent-board needs-you <reason>\` that the zone needs Let agents orchestrate turned on, or that they should start its orchestrator.
- Keep an eye on the orchestrators while you work on a request: \`agent-board watch\`, \`agent-board read\` and their status lines say what they are doing.
- The plans and questions of the orchestrators you start go to the user, not to you: never answer, approve or decide them. A flag from your crew that asks for a decision goes to the user too, with \`agent-board needs-you --via <ref>\`. Answer only what is about routing or status (which zone, whether it is done).
- Keep a digest of what needs the user and how each zone is doing in one agent note beside your tile (\`agent-board note add --near me\`, then \`agent-board note edit\`): a line per item, short.
- When the user asks what is going on, list every agent's state across the zones and say what needs them.

Never answer or decide a permission prompt, approve, merge, delete anyone's worktree, or change a setting: those are the user's. Act only on what the user asks; don't start, nudge or restart agents for anything else.

Read the board now, write your first digest, then wait for the user's request.`;

export interface BoardMasterOptions {
  /** The folder it works in: not a repo, made on its first start. */
  dir: string;
  /** Starts the agent as the user would, marked as the master. */
  spawn(params: SpawnAgentParams, place: FolderPlace): Promise<Agent>;
  agents(): Agent[];
  zones(): Zone[];
}

export interface BoardMaster {
  handlers<Context>(): RpcHandlers<MasterMethods, Context>;
}

/** Where a new master's tile goes: left of the zones' top-left corner, or the origin on a board with none. */
export function masterPosition(zones: readonly Pick<Zone, 'x' | 'y'>[]): { x: number; y: number } {
  if (zones.length === 0) return { x: 0, y: 0 };
  const left = Math.min(...zones.map((zone) => zone.x));
  const top = Math.min(...zones.map((zone) => zone.y));
  return { x: left - TILE_SLOT.width - MASTER_MARGIN, y: top };
}

/** The board master (ADR-0019): one per board, started only by the user, in a folder of its own. */
export function createBoardMaster(options: BoardMasterOptions): BoardMaster {
  /** A start under way, so two clicks make one master. */
  let starting: Promise<Agent> | undefined;

  const start = async (params: Record<string, unknown>): Promise<Agent> => {
    const existing = options.agents().find((agent) => agent.master);
    if (existing !== undefined) return existing;
    const harness = optionalStringParam(params, 'harness') ?? 'claude';
    if (harness !== 'claude' && harness !== 'codex') throw invalidParams(`unknown harness ${harness}`);
    const cols = dimensionParam(params, 'cols');
    const rows = dimensionParam(params, 'rows');
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    return options.spawn(
      {
        zoneId: null,
        position: masterPosition(options.zones()),
        harness: harness as Harness,
        model: optionalStringParam(params, 'model') ?? (harness === 'claude' ? 'opus' : undefined),
        name: 'Board master',
        prompt: MASTER_PROMPT,
        noTemplate: true,
        orchestrate: 'board',
        cols,
        rows,
      },
      { cwd: options.dir, repoRoot: options.dir, readOnly: false, master: true },
    );
  };

  return {
    handlers<Context>(): RpcHandlers<MasterMethods, Context> {
      return {
        'master.start': async (params) => {
          starting ??= start(paramsObject(params)).finally(() => {
            starting = undefined;
          });
          return starting;
        },
      };
    },
  };
}
