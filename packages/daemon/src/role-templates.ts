// Role templates: the prompt an agent started in a role begins with, one per role and zone. A zone's template
// is the one the user saved for it, else its seed: its repo's worker prompt (`.claude/skills/cmux-workers/*-prompt.md`),
// else the app's own. Filling it is plain text substitution, never a shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, oneOf, paramsObject, stringParam } from './params.ts';
import { AGENT_ROLES, MAX_ROLE_TEMPLATE_LENGTH, type AgentRole, type DaemonMethods, type RoleTemplate } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { resolveZoneFolder } from './zones.ts';

/** What a template's `{{name}}`s are filled with. The first four are the ones offered to write; the rest serve the seeds. */
export interface TemplateValues {
  /** The issue's ID, or "no issue". */
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

export interface RoleTemplates {
  /** The template an agent in `role` starts with: `zoneId`'s saved one, else the seed in `repoRoot`. */
  body(zoneId: string | null, repoRoot: string, role: AgentRole): string;
  handlers<Context>(): RpcHandlers<RoleTemplateMethods, Context>;
}

interface TemplateRow {
  body: string;
  edited_at: string;
}

/** The zones' role templates, backed by `role_templates`: a row for each the user saved, the seed for the rest. */
export function createRoleTemplates(db: DatabaseSync): RoleTemplates {
  const selectOne = db.prepare('SELECT body, edited_at FROM role_templates WHERE zone_id = ? AND role = ?');
  const upsert = db.prepare(
    `INSERT INTO role_templates (zone_id, role, body) VALUES (?, ?, ?)
     ON CONFLICT (zone_id, role) DO UPDATE SET body = excluded.body, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const remove = db.prepare('DELETE FROM role_templates WHERE zone_id = ? AND role = ?');
  const selectZone = db.prepare('SELECT repo_root, default_repo FROM zones WHERE id = ?');

  const saved = (zoneId: string, role: AgentRole) => selectOne.get(zoneId, role) as TemplateRow | undefined;

  /** The repo a zone's templates are seeded from: its own, its default repo's, or none. */
  const zoneRepo = async (zoneId: string): Promise<string | null> => {
    const zone = selectZone.get(zoneId) as { repo_root: string | null; default_repo: string | null } | undefined;
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (zone.repo_root !== null) return zone.repo_root;
    if (zone.default_repo === null) return null;
    return (await resolveZoneFolder(zone.default_repo).catch(() => undefined))?.repoRoot ?? null;
  };

  const template = (zoneId: string, repo: string | null, role: AgentRole): RoleTemplate => {
    const seed = roleSeed(repo, role);
    const row = saved(zoneId, role);
    return { role, body: row?.body ?? seed.body, seed: seed.source, editedAt: row?.edited_at ?? null };
  };

  return {
    body(zoneId, repoRoot, role) {
      return (zoneId === null ? undefined : saved(zoneId, role))?.body ?? roleSeed(repoRoot, role).body;
    },

    handlers<Context>(): RpcHandlers<RoleTemplateMethods, Context> {
      return {
        'zone.roleTemplates': async (params) => {
          const id = stringParam(paramsObject(params), 'id');
          const repo = await zoneRepo(id);
          return AGENT_ROLES.map((role) => template(id, repo, role));
        },
        'zone.setRoleTemplate': async (params) => {
          const fields = paramsObject(params);
          const id = stringParam(fields, 'id');
          const role = oneOf(fields, 'role', AGENT_ROLES);
          const body = fields.body;
          if (typeof body !== 'string') throw invalidParams('body must be a string');
          if (body.length > MAX_ROLE_TEMPLATE_LENGTH) throw invalidParams(`a template is at most ${MAX_ROLE_TEMPLATE_LENGTH} characters`);
          const repo = await zoneRepo(id);
          upsert.run(id, role, body);
          return template(id, repo, role);
        },
        'zone.resetRoleTemplate': async (params) => {
          const fields = paramsObject(params);
          const id = stringParam(fields, 'id');
          const role = oneOf(fields, 'role', AGENT_ROLES);
          const repo = await zoneRepo(id);
          remove.run(id, role);
          return template(id, repo, role);
        },
      };
    },
  };
}
