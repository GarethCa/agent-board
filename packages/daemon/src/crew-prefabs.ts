// Crew prefabs: a saved crew shape (its members, when each starts, and when the crew stops) and its `.crew.json` file,
// which is how one is shared. The file is read strictly: a field it doesn't know is refused, so it can never carry a
// prompt, an issue, a repo, a branch, a key or a token, and a typo is said rather than dropped.
import { invalidParams } from './params.ts';
import {
  HARNESSES,
  MAX_NAME_LENGTH,
  MAX_PREFAB_MEMBERS,
  MAX_PREFAB_SUBAGENTS,
  MAX_REVIEW_CAP,
  MAX_ROLE_TEMPLATE_LENGTH,
  MODEL_NAME,
  DEFAULT_PREFAB_ROUND_LIMIT,
  EFFORTS,
  effortRefusal,
  PREFAB_STARTS,
  PREFAB_SUBAGENT_MODELS,
  REVIEWER_ROLES,
  isOrchestratorRole,
  parseRole,
  type CrewPrefab,
  type PrefabMember,
  type PrefabSubagent,
  type PrefabSubagentRuns,
} from './protocol.ts';
import { checkNamedTemplate } from './role-templates.ts';

/** The file format's version, its first field. A file from a newer app is refused, not half read. */
const FILE_VERSION = 1;
const VERSION_FIELD = 'agentBoardCrewPrefab';

/** A crew prefab file's name ends so: `pair.crew.json`. */
const PREFAB_FILE_SUFFIX = '.crew.json';

/** The longest prefab name, purpose line, subagent name and check line. */
const MAX_PREFAB_NAME_LENGTH = 48;
const MAX_PURPOSE_LENGTH = 200;
const MAX_SUBAGENT_NAME_LENGTH = 24;
const MAX_PATHS = 20;

const PREFAB_FIELDS = new Set([VERSION_FIELD, 'name', 'icon', 'purpose', 'roundLimit', 'onBoard', 'members']);
const MEMBER_FIELDS = new Set(['id', 'role', 'name', 'harness', 'model', 'effort', 'template', 'starts', 'subagents']);
const SUBAGENT_FIELDS = new Set(['name', 'checks', 'model', 'access', 'runs']);

const MEMBER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ICON = /^[a-z][a-z0-9-]{0,23}$/;
// As role names: nothing that could hide or reorder what a label shows.
const HIDDEN = /[\p{C}\u2028\u2029]/u;

type Fields = Record<string, unknown>;

function object(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams(`${what} must be an object`);
  return value as Fields;
}

/** Refuses any field `fields` holds but `known`, naming it. */
function onlyKnown(fields: Fields, known: Set<string>, what: string) {
  const unknown = Object.keys(fields).find((key) => !known.has(key));
  if (unknown !== undefined) throw invalidParams(`${what} holds no ${unknown}`);
}

/** A line of text: trimmed, at most `max` characters, with no control or format character. `fallback` when absent. */
function line(fields: Fields, key: string, what: string, max: number, fallback?: string): string {
  const value = fields[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw invalidParams(`${what} must be text`);
  const text = value.trim();
  if (HIDDEN.test(text)) throw invalidParams(`${what} has a control or format character`);
  if (text.length > max) throw invalidParams(`${what} is at most ${max} characters`);
  return text;
}

/** `fields[key]` when it is one of `options`, else `fallback` when absent. */
function choice<T extends string>(fields: Fields, key: string, what: string, options: readonly T[], fallback?: T): T {
  const value = fields[key] ?? fallback;
  if (!options.includes(value as T)) throw invalidParams(`${what} is ${options.slice(0, -1).join(', ')} or ${options.at(-1)}`);
  return value as T;
}

/** A nullable line: null when absent or null. */
function optionalLine(fields: Fields, key: string, what: string, max: number): string | null {
  if (fields[key] === undefined || fields[key] === null) return null;
  const text = line(fields, key, what, max);
  return text === '' ? null : text;
}

function readRuns(value: unknown, what: string): PrefabSubagentRuns {
  if (value === undefined || value === 'every-round' || value === 'first-round') return value ?? 'every-round';
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const fields = value as Fields;
    onlyKnown(fields, new Set(['paths']), `${what}'s runs`);
    const paths = fields.paths;
    if (!Array.isArray(paths) || paths.length === 0) throw invalidParams(`${what} runs only for paths: give at least one path`);
    if (paths.length > MAX_PATHS) throw invalidParams(`${what} runs for at most ${MAX_PATHS} paths`);
    return { paths: paths.map((_, n) => line(paths as unknown as Fields, String(n), `${what}'s path`, 200)) };
  }
  throw invalidParams(`${what} runs every-round, first-round, or for { "paths": [...] }`);
}

function readSubagent(value: unknown, member: string): PrefabSubagent {
  const fields = object(value, `a subagent of ${member}`);
  const name = line(fields, 'name', `a subagent of ${member}'s name`, MAX_SUBAGENT_NAME_LENGTH);
  if (name === '') throw invalidParams(`a subagent of ${member} needs a name`);
  const what = `subagent ${name} of ${member}`;
  onlyKnown(fields, SUBAGENT_FIELDS, what);
  return {
    name,
    checks: line(fields, 'checks', `what ${what} checks`, MAX_PURPOSE_LENGTH, ''),
    model: choice(fields, 'model', `${what}'s model`, PREFAB_SUBAGENT_MODELS, 'member'),
    access: choice(fields, 'access', `${what}'s access`, ['read', 'write'] as const, 'read'),
    runs: readRuns(fields.runs, what),
  };
}

function readMember(value: unknown, index: number): PrefabMember {
  const fields = object(value, `member ${index + 1}`);
  const id = fields.id;
  if (typeof id !== 'string' || !MEMBER_ID.test(id)) {
    throw invalidParams(`member ${index + 1}'s id is lowercase letters, digits and dashes, at most 24 (impl, code-review)`);
  }
  const what = `member ${id}`;
  onlyKnown(fields, MEMBER_FIELDS, what);
  let role: string | null = null;
  let named: string | null = null;
  if (fields.role !== undefined && fields.role !== null) {
    if (typeof fields.role !== 'string') throw invalidParams(`${what}'s role must be text`);
    const parsed = parseRole(fields.role);
    if ('error' in parsed) throw invalidParams(`${what}: ${parsed.error}`);
    role = parsed.name ?? parsed.role;
    named = parsed.name;
  }
  const harness = choice(fields, 'harness', `${what}'s harness`, HARNESSES, 'claude');
  const effort = fields.effort === undefined || fields.effort === null ? null : choice(fields, 'effort', `${what}'s reasoning effort`, EFFORTS);
  const refused = effort === null ? undefined : effortRefusal(harness, effort);
  if (refused !== undefined) throw invalidParams(`${what}: ${refused}`);
  let template: string | null = null;
  if (fields.template !== undefined && fields.template !== null) {
    if (named === null) throw invalidParams(`${what}: only a named role carries a template of its own; a built-in role's is each zone's`);
    if (typeof fields.template !== 'string') throw invalidParams(`${what}'s template must be text`);
    if (fields.template.trim() === '') throw invalidParams(`${what}'s template is empty: leave it out to start with its role's own`);
    if (fields.template.length > MAX_ROLE_TEMPLATE_LENGTH) throw invalidParams(`${what}'s template is at most ${MAX_ROLE_TEMPLATE_LENGTH} characters`);
    checkNamedTemplate(named, fields.template);
    template = fields.template;
  }
  const subagents = fields.subagents ?? [];
  if (!Array.isArray(subagents)) throw invalidParams(`${what}'s subagents must be a list`);
  if (subagents.length > MAX_PREFAB_SUBAGENTS) throw invalidParams(`${what} has at most ${MAX_PREFAB_SUBAGENTS} subagents`);
  const checks = subagents.map((each) => readSubagent(each, id));
  const twice = checks.find((each, n) => checks.findIndex((other) => other.name.toLowerCase() === each.name.toLowerCase()) !== n);
  if (twice !== undefined) throw invalidParams(`${what} has two subagents named ${twice.name}`);
  const model = optionalLine(fields, 'model', `${what}'s model`, 64);
  if (model !== null && !MODEL_NAME.test(model)) throw invalidParams(`${what}'s model is a model's name, such as opus or gpt-5-codex`);
  return {
    id,
    role,
    name: optionalLine(fields, 'name', `${what}'s name`, MAX_NAME_LENGTH),
    harness,
    model,
    effort,
    template,
    starts: choice(fields, 'starts', `when ${what} starts`, PREFAB_STARTS, 'prompt'),
    subagents: checks,
  };
}

/** Refuses a template on a member the crew can't start with it: only the member that starts on the prompt is started whole. */
function checkTemplates(members: PrefabMember[]) {
  const later = members.find((member) => member.template !== null && member.starts !== 'prompt');
  if (later !== undefined) {
    throw invalidParams(`${later.id} carries a template, but only the member that starts on the prompt starts with one of its own: leave it out, and ${later.id} starts with its role's`);
  }
}

/** Refuses members that pass work in no way the crew can run. */
function checkFlow(members: PrefabMember[]) {
  const first = members.filter((member) => member.starts === 'prompt');
  if (first.length !== 1) {
    throw invalidParams(`a crew has one member that starts on the prompt, its builder or its lead; this one has ${first.length}`);
  }
  const lead = isOrchestratorRole(first[0]!.role);
  for (const member of members) {
    if (member.starts === 'handoff' && !REVIEWER_ROLES.includes(member.role as never)) {
      throw invalidParams(`${member.id} starts at the hand-off, so it is a reviewer or follow-up reviewer, which reviews the builder's branch`);
    }
    if (member.starts === 'handoff' && lead) {
      throw invalidParams(`${member.id} starts at the hand-off, but a crew with a lead has the lead start its reviewers: start it by the lead`);
    }
    if (member.starts === 'lead' && !lead) {
      throw invalidParams(`${member.id} is started by the lead, so the member that starts on the prompt is an orchestrator`);
    }
  }
}

/** A crew prefab from its parsed file, or `invalidParams` saying what is wrong with it. */
function readPrefab(value: unknown): CrewPrefab {
  const fields = object(value, 'a crew prefab');
  const version = fields[VERSION_FIELD];
  if (version === undefined) throw invalidParams(`not a crew prefab file: it has no ${VERSION_FIELD} version`);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw invalidParams(`${VERSION_FIELD} is a version number`);
  if (version > FILE_VERSION) throw invalidParams(`this crew prefab is from a newer version of agent-board (file version ${version}): update the app to read it`);
  onlyKnown(fields, PREFAB_FIELDS, 'a crew prefab');
  const name = line(fields, 'name', "the prefab's name", MAX_PREFAB_NAME_LENGTH);
  if (name === '') throw invalidParams('a crew prefab needs a name');
  const icon = fields.icon ?? 'crew';
  if (typeof icon !== 'string' || !ICON.test(icon)) throw invalidParams("the prefab's icon is a name in lowercase letters, digits and dashes");
  const roundLimit = fields.roundLimit ?? DEFAULT_PREFAB_ROUND_LIMIT;
  if (typeof roundLimit !== 'number' || !Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > MAX_REVIEW_CAP) {
    throw invalidParams(`the round limit is a whole number from 1 to ${MAX_REVIEW_CAP}`);
  }
  const members = fields.members;
  if (!Array.isArray(members) || members.length === 0) throw invalidParams('a crew prefab has at least one member');
  if (members.length > MAX_PREFAB_MEMBERS) throw invalidParams(`a crew prefab has at most ${MAX_PREFAB_MEMBERS} members`);
  const read = members.map(readMember);
  const twice = read.find((member, n) => read.findIndex((other) => other.id === member.id) !== n);
  if (twice !== undefined) throw invalidParams(`two members are ${twice.id}: each has an id of its own`);
  checkFlow(read);
  checkTemplates(read);
  return {
    name,
    icon,
    purpose: line(fields, 'purpose', "the prefab's purpose", MAX_PURPOSE_LENGTH, ''),
    roundLimit,
    onBoard: choice(fields, 'onBoard', 'onBoard', ['card', 'tiles'] as const, 'card'),
    members: read,
  };
}

/** A crew prefab from a `.crew.json` file's text, or `invalidParams` saying what is wrong with it. */
export function parsePrefab(text: string): CrewPrefab {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidParams('not a crew prefab file: it is not JSON');
  }
  return readPrefab(value);
}

/** `prefab` as a `.crew.json` file's text, every field written out, its version first. */
export function prefabFile(prefab: CrewPrefab): string {
  const { name, icon, purpose, roundLimit, onBoard, members } = prefab;
  return `${JSON.stringify({ [VERSION_FIELD]: FILE_VERSION, name, icon, purpose, roundLimit, onBoard, members }, null, 2)}\n`;
}

/** A file name for `prefab`: its name in lowercase words joined by dashes, then `.crew.json`. */
export function prefabFileName(prefab: Pick<CrewPrefab, 'name'>): string {
  const stem = prefab.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${stem || 'crew'}${PREFAB_FILE_SUFFIX}`;
}

const member = (fields: Partial<PrefabMember> & Pick<PrefabMember, 'id' | 'role' | 'starts'>): PrefabMember => ({
  name: null,
  harness: 'claude',
  model: null,
  effort: null,
  template: null,
  subagents: [],
  ...fields,
});

const prefab = (fields: Omit<CrewPrefab, 'roundLimit' | 'onBoard'> & Partial<CrewPrefab>): CrewPrefab => ({
  roundLimit: DEFAULT_PREFAB_ROUND_LIMIT,
  onBoard: 'card',
  ...fields,
});

/** The app's own prefabs, in the library's order. None can be saved over: save a copy under a name of its own. */
export const BUILT_IN_PREFABS: readonly CrewPrefab[] = [
  prefab({
    name: 'Solo agent',
    icon: 'agent',
    purpose: 'One agent, as New agent starts it',
    members: [member({ id: 'agent', role: null, starts: 'prompt' })],
  }),
  prefab({
    name: 'Implementer + reviewer',
    icon: 'review',
    purpose: 'One builds; a reviewer checks each hand-off until it approves',
    members: [member({ id: 'impl', role: 'implementer', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
  }),
  prefab({
    name: 'Implementer + code + design reviewers',
    icon: 'review',
    purpose: 'One builds; a code reviewer and a design reviewer must both approve',
    members: [
      member({ id: 'impl', role: 'implementer', starts: 'prompt' }),
      member({ id: 'code-review', role: 'reviewer', name: 'code review', starts: 'handoff' }),
      member({ id: 'design-review', role: 'reviewer', name: 'design review', starts: 'handoff' }),
    ],
  }),
  prefab({
    name: 'Spike + reviewer',
    icon: 'spike',
    purpose: 'A quick spike to answer a question, then a review of what it found',
    roundLimit: 1,
    members: [member({ id: 'spike', role: 'spike', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
  }),
  prefab({
    name: 'Lead and crew',
    icon: 'lead',
    purpose: 'An orchestrator that starts and runs its own implementer and reviewer',
    onBoard: 'tiles',
    members: [
      member({ id: 'lead', role: 'orchestrator', starts: 'prompt' }),
      member({ id: 'impl', role: 'implementer', starts: 'lead' }),
      member({ id: 'review', role: 'reviewer', starts: 'lead' }),
    ],
  }),
];
