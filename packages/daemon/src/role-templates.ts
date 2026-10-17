// Role templates: the prompt an agent started in a role begins with, one per role and zone. A zone's template
// is the one the user saved for it, else its seed: its repo's worker prompt (a `*-prompt.md` in its worker skill),
// else the app's own. A named custom role's is the zone's saved one for the name, else the app's default role
// of that name, else empty: never a seed. Filling it is plain text substitution, never a shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BoardConnection } from './board.ts';
import type { ActivityEntry, OrchestratorAccess } from './orchestrators.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  AGENT_ROLES,
  BOARD_ERROR,
  MAX_ROLE_TEMPLATE_LENGTH,
  orchestratorTextRefusal,
  parseRole,
  type AgentRole,
  type DaemonMethods,
  type DefaultRole,
  type RoleTemplate,
  type Zone,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { resolveZoneFolder } from './zones.ts';

/** What a template's `{{name}}`s are filled with. The first four are the ones offered to write; the rest serve the seeds. */
export interface TemplateValues {
  /** The issue's ID, or "none": never its branch. */
  issue: string;
  /** Its branch: for a reviewer, the branch it reviews. */
  branch: string;
  worktree: string;
  /** The previous review of the branch, or "none". */
  prev_review: string;
  /** Which review of the branch this is, from 1. */
  round: string;
  /** The worktree of the agent whose branch it reviews, or "none". */
  impl_worktree: string;
  /** The commit the previous review was of, or "none". */
  prev_sha: string;
}

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

/**
 * `body` with each `{{name}}` of `values` replaced by its value, in one pass, so no value is read as a pattern or filled
 * into again. Anything else, `{{OTHER}}` included, stays as written.
 */
export function fillTemplate(body: string, values: TemplateValues): string {
  return body.replace(VARIABLE, (whole, name: string) => (Object.hasOwn(values, name) ? values[name as keyof TemplateValues] : whole));
}

/** Where a repo keeps its worker prompts, and the one each role is seeded from. */
const PROMPTS_DIR = join('.claude', 'skills', 'cmux-workers');
const SEED_FILES: Partial<Record<AgentRole, string>> = {
  implementer: 'impl-prompt.md',
  reviewer: 'review-prompt.md',
  'follow-up-reviewer': 'rereview-prompt.md',
};

/** The worker prompts write their variables in capitals (`{{ISSUE}}`): the same names, as the app writes them. */
const SEED_VARIABLE = /\{\{([A-Z_]+)\}\}/g;
const SEED_NAMES = new Set<string>(['issue', 'branch', 'worktree', 'prev_review', 'round', 'impl_worktree', 'prev_sha']);

/** A role's template when none is saved: the body, and the repo's prompt file it came from (null for the app's own). */
export interface RoleSeed {
  body: string;
  source: string | null;
}

/** A role's seed in `repoRoot` (or with no repo): its worker prompt file if it has one, else the app's own template. */
export function roleSeed(repoRoot: string | null, role: AgentRole): RoleSeed {
  const file = SEED_FILES[role];
  if (file === undefined) return { body: '', source: null };
  if (repoRoot !== null) {
    try {
      const text = readFileSync(join(repoRoot, PROMPTS_DIR, file), 'utf8');
      const body = text.replace(SEED_VARIABLE, (whole, name: string) =>
        SEED_NAMES.has(name.toLowerCase()) ? `{{${name.toLowerCase()}}}` : whole,
      );
      return { body, source: file };
    } catch {
      // No such prompt in this repo: the app's own.
    }
  }
  return { body: BUILT_IN[role] ?? '', source: null };
}

/** The app's own templates, for a repo without worker prompts. */
const BUILT_IN: Partial<Record<AgentRole, string>> = {
  implementer: `You are the implementer for {{issue}}.

- Worktree: \`{{worktree}}\` (your current directory). Branch: \`{{branch}}\`.

Read the issue and the repo's own instructions first. Work test-first, commit in small steps on \`{{branch}}\`, and
write what you did, how to verify it and anything left over in \`.agent-board/handover.md\` before you finish.`,
  reviewer: `You are an adversarial reviewer for {{issue}}, review round {{round}}.

- Worktree: \`{{worktree}}\` (your current directory), a detached checkout of branch \`{{branch}}\`.
- The implementer's worktree: \`{{impl_worktree}}\`. Its handover is \`.agent-board/handover.md\` there: verify its claims.

Find what is wrong, not confirm it works. Read the whole diff and the code around it, run the checks, and try to break
it. Every finding names a file:line, says why it is wrong and what should change, tagged [blocker], [major] or [minor].
Write the review to \`.agent-board/review.md\`, its first line \`VERDICT: approve\` or \`VERDICT: changes-requested\`.
Do not edit code and do not push.`,
  'follow-up-reviewer': `You are the follow-up reviewer for {{issue}}, review round {{round}}.

- Worktree: \`{{worktree}}\` (your current directory), a detached checkout of branch \`{{branch}}\`.
- Previous review: \`{{prev_review}}\`, of commit \`{{prev_sha}}\`.

Check each blocker and major of the previous review is fixed, and that the commits since \`{{prev_sha}}\` break nothing.
Write the review to \`.agent-board/review.md\`, its first line \`VERDICT: approve\` or \`VERDICT: changes-requested\`.
Do not edit code and do not push.`,
};

type RoleTemplateMethods = Pick<DaemonMethods, 'zone.roleTemplates' | 'zone.setRoleTemplate' | 'zone.resetRoleTemplate'>;
type DefaultRoleMethods = Pick<DaemonMethods, 'orchestrator.roles' | 'orchestrator.setRole' | 'orchestrator.removeRole'>;

/** A role as an agent is started in it: a built-in role, or a custom one with its name. */
export interface RoleChoice {
  role: AgentRole;
  name: string | null;
}

/** `text` as `parseRole` reads it, else `invalidParams` saying why not. */
export function roleChoice(text: string): RoleChoice {
  const parsed = parseRole(text);
  if ('error' in parsed) throw invalidParams(parsed.error);
  return parsed;
}

/**
 * Throws `invalidParams` unless a named role's template (filled in or not) is text an orchestrator may send: an
 * orchestrator may write one, and it starts other agents' first messages, so it gets the same allowlist as a prompt
 * (`orchestratorTextRefusal`). Checked when it is saved and again when an agent starts with it.
 */
export function checkNamedTemplate(name: string, body: string): void {
  const why = orchestratorTextRefusal(body);
  if (why !== undefined) throw invalidParams(`the ${name} role's template may not start an agent: ${why}`);
}

/** A template's body as given: a string of at most `MAX_ROLE_TEMPLATE_LENGTH`. */
function templateBody(fields: Record<string, unknown>): string {
  const body = fields.body;
  if (typeof body !== 'string') throw invalidParams('body must be a string');
  if (body.length > MAX_ROLE_TEMPLATE_LENGTH) throw invalidParams(`a template is at most ${MAX_ROLE_TEMPLATE_LENGTH} characters`);
  return body;
}

export interface RoleTemplates {
  /**
   * The template an agent in `choice` starts with: `zoneId`'s saved one for it, else, for a built-in role, its seed in
   * `repoRoot`, and for a named one the app's default role of the name, else nothing.
   */
  body(zoneId: string | null, repoRoot: string, choice: RoleChoice): string;
  /** Where `body` comes from, in words: a zone's saved template, a repo's seed file (named), the app's own template or a default role. */
  describe(zoneId: string | null, repoRoot: string, choice: RoleChoice): string;
  handlers<Context>(): RpcHandlers<RoleTemplateMethods, Context>;
  /**
   * `orchestrator.roles`, `setRole` and `removeRole`: the app's default roles (a board-scope orchestrator's), or a zone's
   * template for a name (a zone in the caller's scope), checked and logged as `access` does.
   */
  defaultRoleHandlers<Context extends BoardConnection>(access: OrchestratorAccess, zones: () => Zone[]): RpcHandlers<DefaultRoleMethods, Context>;
}

interface TemplateRow {
  role: string;
  body: string;
  edited_at: string;
}

interface DefaultRoleRow {
  name: string;
  body: string;
  edited_at: string;
}

const toDefaultRole = (row: DefaultRoleRow): DefaultRole => ({ name: row.name, body: row.body, editedAt: row.edited_at });

/** A name as the database's NOCASE compares it: ASCII letters in either case, anything else as it is. */
const asciiFolded = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The names a zone's role templates list besides the built-in roles, one per name in any case, in name order. */
function namedRoles(...lists: string[][]): string[] {
  const byKey = new Map<string, string>();
  for (const name of lists.flat()) if (!byKey.has(asciiFolded(name))) byKey.set(asciiFolded(name), name);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * The zones' role templates, backed by `role_templates`: a row for each the user saved, the seed for the rest; and the
 * app's default roles, backed by `default_roles`. A named role's row is keyed by its name, matched in any case.
 */
export function createRoleTemplates(db: DatabaseSync): RoleTemplates {
  const selectOne = db.prepare('SELECT role, body, edited_at FROM role_templates WHERE zone_id = ? AND role = ? COLLATE NOCASE');
  const selectNamed = db.prepare('SELECT role FROM role_templates WHERE zone_id = ?');
  const removeOne = db.prepare('DELETE FROM role_templates WHERE zone_id = ? AND role = ? COLLATE NOCASE');
  const insertOne = db.prepare('INSERT INTO role_templates (zone_id, role, body) VALUES (?, ?, ?) RETURNING edited_at');
  const selectZone = db.prepare('SELECT repo_root, default_repo FROM zones WHERE id = ?');
  const selectUsedNames = db.prepare('SELECT DISTINCT role_name FROM agents WHERE zone_id = ? AND role_name IS NOT NULL');
  const selectDefaults = db.prepare('SELECT name, body, edited_at FROM default_roles ORDER BY name');
  const selectDefault = db.prepare('SELECT name, body, edited_at FROM default_roles WHERE name = ?');
  const upsertDefault = db.prepare(
    `INSERT INTO default_roles (name, body) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET name = excluded.name, body = excluded.body, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING name, body, edited_at`,
  );
  const removeDefault = db.prepare('DELETE FROM default_roles WHERE name = ?');

  const key = (choice: RoleChoice) => choice.name ?? choice.role;
  const saved = (zoneId: string, choice: RoleChoice) => selectOne.get(zoneId, key(choice)) as TemplateRow | undefined;
  const appDefault = (name: string) => selectDefault.get(name) as DefaultRoleRow | undefined;

  /** The repo a zone's templates are seeded from: its own, its default repo's, or none. */
  const zoneRepo = async (zoneId: string): Promise<string | null> => {
    const zone = selectZone.get(zoneId) as { repo_root: string | null; default_repo: string | null } | undefined;
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (zone.repo_root !== null) return zone.repo_root;
    if (zone.default_repo === null) return null;
    return (await resolveZoneFolder(zone.default_repo).catch(() => undefined))?.repoRoot ?? null;
  };

  /** A role's template when the zone saved none: a built-in's seed, a named role's app default, else empty. */
  const unsaved = (repo: string | null, choice: RoleChoice): { role: string; body: string; seed: string | null; appDefault: boolean } => {
    if (choice.name === null) {
      const seed = roleSeed(repo, choice.role);
      return { role: choice.role, body: seed.body, seed: seed.source, appDefault: false };
    }
    const fallback = appDefault(choice.name);
    return { role: fallback?.name ?? choice.name, body: fallback?.body ?? '', seed: null, appDefault: fallback !== undefined };
  };

  const template = (zoneId: string, repo: string | null, choice: RoleChoice): RoleTemplate => {
    const fallback = unsaved(repo, choice);
    const row = saved(zoneId, choice);
    return row === undefined
      ? { ...fallback, editedAt: null }
      : { role: row.role, body: row.body, seed: fallback.seed, appDefault: false, editedAt: row.edited_at };
  };

  /** A custom role's name, for the app's default roles: never a built-in role's. */
  const defaultName = (fields: Record<string, unknown>): string => {
    const text = stringParam(fields, 'name');
    const { name } = roleChoice(text);
    if (name === null) throw invalidParams(`${text.trim()} is a built-in role: its template is each zone's, under Role templates…`);
    return name;
  };

  /**
   * Where `setRole` and `removeRole` write: `zoneId`'s templates, a zone in `me`'s scope; else the app's list, which
   * reaches every zone, so a board-scope orchestrator's (or the user's side's) alone.
   */
  const target = (access: OrchestratorAccess, me: Parameters<OrchestratorAccess['reachesZone']>[0], fields: Record<string, unknown>, zones: () => Zone[]) => {
    const zoneId = optionalStringParam(fields, 'zoneId');
    if (zoneId === undefined) {
      if (me.orchestrate !== 'board') {
        throw new RpcMethodError(
          BOARD_ERROR.outOfScope,
          `the app's default roles reach every zone, so they are for an orchestrator of the whole board; your scope is ${access.scopeText(me)}: set your zone's template with --zone`,
        );
      }
      return undefined;
    }
    const zone = zones().find((each) => each.id === zoneId);
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (!access.reachesZone(me, zone)) throw new RpcMethodError(BOARD_ERROR.outOfScope, `${zone.name} is outside your scope (${access.scopeText(me)})`);
    return zone;
  };

  return {
    describe(zoneId, repoRoot, choice) {
      const label = key(choice);
      if (zoneId !== null && saved(zoneId, choice) !== undefined) return `the zone's saved ${label} template`;
      if (choice.name !== null) return `the app's default ${label} role`;
      const { seed } = unsaved(repoRoot, choice);
      return seed === null ? `the app's own ${label} template` : `the repo's ${label} seed (${seed})`;
    },
    body(zoneId, repoRoot, choice) {
      const row = zoneId === null ? undefined : saved(zoneId, choice);
      return row?.body ?? unsaved(repoRoot, choice).body;
    },

    handlers<Context>(): RpcHandlers<RoleTemplateMethods, Context> {
      return {
        'zone.roleTemplates': async (params) => {
          const id = stringParam(paramsObject(params), 'id');
          const repo = await zoneRepo(id);
          const names = namedRoles(
            (selectNamed.all(id) as { role: string }[]).map(({ role }) => role).filter((role) => !AGENT_ROLES.includes(role as AgentRole)),
            (selectUsedNames.all(id) as { role_name: string }[]).map(({ role_name }) => role_name),
            (selectDefaults.all() as unknown as DefaultRoleRow[]).map(({ name }) => name),
          );
          return [
            ...AGENT_ROLES.map((role) => template(id, repo, { role, name: null })),
            ...names.map((name) => template(id, repo, { role: 'custom', name })),
          ];
        },
        'zone.setRoleTemplate': async (params) => {
          const fields = paramsObject(params);
          const id = stringParam(fields, 'id');
          const choice = roleChoice(stringParam(fields, 'role'));
          const body = templateBody(fields);
          if (choice.name !== null) checkNamedTemplate(choice.name, body);
          const repo = await zoneRepo(id);
          // One row per name in any case: the last spelling saved is the one kept.
          removeOne.run(id, key(choice));
          insertOne.run(id, key(choice), body);
          return template(id, repo, choice);
        },
        'zone.resetRoleTemplate': async (params) => {
          const fields = paramsObject(params);
          const id = stringParam(fields, 'id');
          const choice = roleChoice(stringParam(fields, 'role'));
          const repo = await zoneRepo(id);
          removeOne.run(id, key(choice));
          return template(id, repo, choice);
        },
      };
    },

    defaultRoleHandlers<Context extends BoardConnection>(access: OrchestratorAccess, zones: () => Zone[]): RpcHandlers<DefaultRoleMethods, Context> {
      /** What the log names: the role, and the zone whose template it is. */
      const logged = (name: string, zone: Zone | undefined) => ({ id: `role:${name}`, name: zone === undefined ? name : `${name} (${zone.name})` });
      return {
        'orchestrator.roles': (params, connection) => {
          access.caller('orchestrator.roles', paramsObject(params), connection);
          return (selectDefaults.all() as unknown as DefaultRoleRow[]).map(toDefaultRole);
        },
        'orchestrator.setRole': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.setRole', fields, connection);
          const entry: ActivityEntry = { detail: typeof fields.name === 'string' ? fields.name.trim() : '' };
          return access.logged(me, 'set-role', entry, () => {
            const name = defaultName(fields);
            entry.detail = name;
            entry.on = logged(name, undefined);
            const zone = target(access, me, fields, zones);
            entry.on = logged(name, zone);
            const body = templateBody(fields);
            checkNamedTemplate(name, body);
            if (zone === undefined) return toDefaultRole(upsertDefault.get(name, body) as unknown as DefaultRoleRow);
            removeOne.run(zone.id, name);
            const { edited_at } = insertOne.get(zone.id, name, body) as { edited_at: string };
            return { name, body, editedAt: edited_at };
          });
        },
        'orchestrator.removeRole': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.removeRole', fields, connection);
          const entry: ActivityEntry = { detail: typeof fields.name === 'string' ? fields.name.trim() : '' };
          return access.logged(me, 'remove-role', entry, () => {
            // Read as `setRole` reads it, so what was set can be removed as it was typed. A built-in role is refused: its
            // zone templates are the user's, never an orchestrator's to reset.
            const name = defaultName(fields);
            entry.detail = name;
            entry.on = logged(name, undefined);
            const zone = target(access, me, fields, zones);
            entry.on = logged(name, zone);
            const removed = zone === undefined ? removeDefault.run(name).changes : removeOne.run(zone.id, name).changes;
            if (removed === 0) throw invalidParams(zone === undefined ? `the app has no default role ${name}` : `${zone.name} has no template of its own for ${name}`);
            return null;
          });
        },
      };
    },
  };
}
