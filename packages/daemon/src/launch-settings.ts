import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams } from './params.ts';
import { ENV_NAME, envPair, type Harness, type LaunchSettingKeys, type LaunchSettings } from './protocol.ts';

/**
 * The most an agent's launch settings may take, in bytes of JSON: what fits in one keychain item, which `security -i`
 * takes on one line of at most 4,000 bytes, as base64 (`launch-settings-keychain.ts`).
 */
export const MAX_LAUNCH_SETTINGS_BYTES = 2_048;

/** The env the board sets for itself: an agent's own would cut it off from the board, or point it at another agent. */
const BOARD_ENV_PREFIX = 'AGENT_BOARD_';

/** Env the board clears itself: an agent started from inside Claude Code must not think it is nested. */
const RESERVED_ENV = new Set(['CLAUDECODE']);

/** Claude settings the board's own launch needs: its hooks, and its status line, which posts plan usage. */
const RESERVED_SETTINGS = new Set(['hooks', 'statusLine', 'disableAllHooks', 'allowManagedHooksOnly']);

/** Claude settings that say what an agent may do unasked: the user's to set in Claude Code, never at a launch. */
const PERMISSION_SETTINGS = new Set(['permissions', 'skipDangerousModePermissionPrompt']);

/** Claude settings the board sets with flags of its own (`--model`, `--effort`), which beat them and the tile shows. */
const FLAG_SETTINGS = new Map([
  ['model', '--model'],
  ['effortLevel', '--effort'],
]);

/**
 * Env vars an agent may set, for itself or another agent: plain knobs of the harness. None loads code (`NODE_OPTIONS`,
 * `DYLD_*`, a shell's `ZDOTDIR` or `BASH_ENV`), moves where the harness, its shell or its config are found (`PATH`,
 * `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), wraps its commands, or sends its traffic or account elsewhere
 * (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`). The user sets any other from the app.
 */
const AGENT_ENV = new Set([
  'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'MAX_MCP_OUTPUT_TOKENS',
  // Switches that only turn off what talks to the outside or the terminal title, by exact name: a prefix would also
  // open any later switch that turns off a safety check, and every command the agent runs inherits the var.
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
]);

/**
 * Claude settings an agent may set: plain options. None runs a command (`apiKeyHelper`, `awsAuthRefresh`,
 * `otelHeadersHelper`, `fileSuggestion`), loads MCP servers or plugins, or says what the agent may do unasked.
 * `env` takes the same env vars as above.
 */
const AGENT_SETTINGS = new Set(['alwaysThinkingEnabled', 'outputStyle', 'includeCoAuthoredBy', 'includeGitInstructions', 'spinnerTipsEnabled', 'language', 'env']);

const agentMaySetEnv = (name: string) => AGENT_ENV.has(name);

function agentEnvCheck(value: unknown, where: string): void {
  if (!plainObject(value)) return;
  const refused = Object.keys(value).find((name) => !agentMaySetEnv(name));
  if (refused !== undefined) {
    throw invalidParams(`${where}: ${refused} is not one an agent may set. An agent may set ${[...AGENT_ENV].join(', ')}; the user sets others from the app (New agent, Restart with…)`);
  }
}

/**
 * Refuses launch settings an agent may not give (from the CLI or MCP, for itself or another agent): any env var or Claude
 * setting outside the plain knobs above. What the user types in the app is not held to it. Checks only what it can
 * read: the shape is `launchSettingsParam`'s to check.
 */
export function checkAgentLaunchSettings(value: unknown): void {
  if (!plainObject(value)) return;
  agentEnvCheck(value.env, 'launchSettings.env');
  if (!plainObject(value.settings)) return;
  const refused = Object.keys(value.settings).find((key) => !AGENT_SETTINGS.has(key));
  if (refused !== undefined) {
    throw invalidParams(`launchSettings.settings: ${refused} is not one an agent may set. An agent may set ${[...AGENT_SETTINGS].join(', ')}`);
  }
  agentEnvCheck(value.settings.env, 'launchSettings.settings.env');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envParam(value: unknown, where: string): Record<string, string> {
  if (!plainObject(value)) throw invalidParams(`${where} must be an object of env var names and values`);
  const env: Record<string, string> = {};
  for (const [name, each] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) throw invalidParams(`${where}: ${JSON.stringify(name)} is not an env var name`);
    if (name.toUpperCase().startsWith(BOARD_ENV_PREFIX)) throw invalidParams(`${where}: ${name} is the board's own: no ${BOARD_ENV_PREFIX}* env var may be set`);
    if (RESERVED_ENV.has(name)) throw invalidParams(`${where}: ${name} is the board's to set`);
    if (typeof each !== 'string') throw invalidParams(`${where}: ${name} must be a string`);
    if (each.includes('\x00')) throw invalidParams(`${where}: ${name} holds a NUL character`);
    env[name] = each;
  }
  return env;
}

/**
 * An agent's launch settings from an RPC param: env vars (any harness) and Claude `--settings` (Claude only). Refuses
 * what would cut the agent off from the board: its `AGENT_BOARD_*` env, and the hooks and status line it launches
 * Claude with. Undefined when none was given; empty parts are left out.
 */
export function launchSettingsParam(value: unknown, harness: Harness): LaunchSettings | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw invalidParams('launchSettings must be an object with env and settings');
  const unknown = Object.keys(value).find((key) => key !== 'env' && key !== 'settings');
  if (unknown !== undefined) throw invalidParams(`launchSettings takes env and settings, not ${unknown}`);
  const out: LaunchSettings = {};
  if (value.env !== undefined) {
    const env = envParam(value.env, 'launchSettings.env');
    if (Object.keys(env).length > 0) out.env = env;
  }
  if (value.settings !== undefined) {
    if (!plainObject(value.settings)) throw invalidParams('launchSettings.settings must be an object, as claude --settings takes');
    const keys = Object.keys(value.settings);
    if (harness === 'codex' && keys.length > 0) throw invalidParams('Codex takes no Claude settings: give it env vars alone');
    const reserved = keys.find((key) => RESERVED_SETTINGS.has(key));
    if (reserved !== undefined) throw invalidParams(`launchSettings.settings: ${reserved} is the board's own, which it needs to see the agent`);
    const permission = keys.find((key) => PERMISSION_SETTINGS.has(key));
    if (permission !== undefined) throw invalidParams(`launchSettings.settings: ${permission} is a permission setting, which only Claude Code's own settings set`);
    const flag = keys.find((key) => FLAG_SETTINGS.has(key));
    if (flag !== undefined) throw invalidParams(`launchSettings.settings: ${flag} is set with the agent's ${FLAG_SETTINGS.get(flag)}, which the board passes and its tile shows`);
    if (value.settings.env !== undefined) envParam(value.settings.env, 'launchSettings.settings.env');
    if (keys.length > 0) out.settings = value.settings;
  }
  if (tooLong(out)) throw invalidParams(`launchSettings are too long: ${MAX_LAUNCH_SETTINGS_BYTES} bytes of JSON at most`);
  return out;
}

/**
 * `KEY=VALUE` pairs, as `--env` takes them, as an env object (`envPair`'s rule). An empty pair adds nothing, so
 * `--env ''` alone gives no env vars, as a restart takes to clear them.
 */
export function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    if (pair === '') continue;
    const parsed = envPair(pair);
    if (parsed === undefined) throw new Error(`--env takes KEY=VALUE, got ${JSON.stringify(pair)}`);
    env[parsed.name] = parsed.value;
  }
  return env;
}

export function isEmptyLaunchSettings(settings: LaunchSettings | undefined): boolean {
  return settings === undefined || (Object.keys(settings.env ?? {}).length === 0 && Object.keys(settings.settings ?? {}).length === 0);
}

/** Whether launch settings are past {@link MAX_LAUNCH_SETTINGS_BYTES}. */
export function tooLong(settings: LaunchSettings): boolean {
  return Buffer.byteLength(JSON.stringify(settings)) > MAX_LAUNCH_SETTINGS_BYTES;
}

/*
 * The `agents.launch_settings` column holds an agent's launch setting names alone, as `LaunchSettingKeys` JSON, or
 * null for none: their values may be secrets, which the keychain keeps (`launch-settings-keychain.ts`). An older
 * build kept the values there too, as `LaunchSettings` JSON: its env and settings are objects, where the names'
 * are arrays. The daemon moves those to the keychain as it starts.
 */

function parseColumn(column: string | null): Record<string, unknown> | undefined {
  if (column === null) return undefined;
  try {
    const value: unknown = JSON.parse(column);
    return plainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The column for an agent's launch settings: their names alone, or null for none. */
export function launchSettingNamesColumn(settings: LaunchSettings | undefined): string | null {
  const keys = launchSettingKeys(settings);
  return keys === null ? null : JSON.stringify(keys);
}

/**
 * The values an agent's column still holds, as an older build kept them, or undefined when it holds names alone, none,
 * or what doesn't read as launch settings.
 */
export function heldLaunchSettings(column: string | null): LaunchSettings | undefined {
  const value = parseColumn(column);
  if (value === undefined) return undefined;
  const settings: LaunchSettings = {
    ...(plainObject(value.env) ? { env: value.env as Record<string, string> } : {}),
    ...(plainObject(value.settings) ? { settings: value.settings } : {}),
  };
  return isEmptyLaunchSettings(settings) ? undefined : settings;
}

/** The names of an agent's launch settings, from its column in either form. Null for none. */
export function launchSettingNames(column: string | null): LaunchSettingKeys | null {
  const held = heldLaunchSettings(column);
  if (held !== undefined) return launchSettingKeys(held);
  const value = parseColumn(column);
  if (value === undefined) return null;
  const names = (part: unknown) => (Array.isArray(part) ? part.filter((name): name is string => typeof name === 'string') : []);
  const keys = { env: names(value.env), settings: names(value.settings) };
  return keys.env.length === 0 && keys.settings.length === 0 ? null : keys;
}

/**
 * Puts their names in place of the values any agent's column in `db` still holds, as an older build kept them: in a
 * backup of the database, whose values the keychain may never have had. Returns how many agents it changed. A
 * database from before agents had launch settings has nothing to change. The values are overwritten only if `db` has
 * `secure_delete` on.
 */
export function keepLaunchSettingNamesOnly(db: DatabaseSync): number {
  const columns = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'launch_settings')) return 0;
  const rows = db.prepare('SELECT session_id, launch_settings FROM agents WHERE launch_settings IS NOT NULL').all() as { session_id: string; launch_settings: string }[];
  const set = db.prepare('UPDATE agents SET launch_settings = ? WHERE session_id = ?');
  let changed = 0;
  for (const row of rows) {
    const held = heldLaunchSettings(row.launch_settings);
    if (held === undefined) continue;
    set.run(launchSettingNamesColumn(held), row.session_id);
    changed++;
  }
  return changed;
}

/**
 * The `claude --settings` the board launches with, `base`, with the agent's own added: its settings' keys win, and
 * its env vars go in the settings' `env` block, over its settings' own `env`. Claude's `--settings` outranks the
 * user's settings, so an env var set there beats one the user's `~/.claude/settings.json` sets, as the process env
 * alone would not.
 */
export function withOwnSettings(base: Record<string, unknown>, own: LaunchSettings | undefined): Record<string, unknown> {
  if (own === undefined) return base;
  const settings = own.settings ?? {};
  const env = { ...(plainObject(settings.env) ? settings.env : {}), ...own.env };
  return { ...base, ...settings, ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/** What may be shown of an agent's launch settings: the names alone, as values may be secrets. Null for none. */
export function launchSettingKeys(settings: LaunchSettings | undefined): LaunchSettingKeys | null {
  if (settings === undefined || isEmptyLaunchSettings(settings)) return null;
  return { env: Object.keys(settings.env ?? {}), settings: Object.keys(settings.settings ?? {}) };
}

/** The file an agent's `claude --settings` is written to when it has launch settings of its own. */
function launchSettingsFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

/**
 * Writes the agent's `claude --settings` to its file, readable by the user alone, and returns the path: its env
 * values may be secrets, which a command-line argument would show to anyone running `ps`.
 */
export function writeLaunchSettingsFile(dir: string, sessionId: string, settings: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = launchSettingsFile(dir, sessionId);
  // Made with no access for others before a byte of it is written, and kept so if it was there.
  writeFileSync(path, '', { mode: 0o600 });
  chmodSync(path, 0o600);
  writeFileSync(path, settings);
  return path;
}

/** Removes the agent's settings file, if it has one. */
export function removeLaunchSettingsFile(dir: string, sessionId: string): void {
  rmSync(launchSettingsFile(dir, sessionId), { force: true });
}
