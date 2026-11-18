// Crew prefabs: a saved crew shape (its members, its inputs and loop gates, and the lines between them) and its
// `.crew.json` file, which is how one is shared. The file is read strictly: a field it doesn't know is refused, so it
// can never carry a prompt, an issue, a repo, a branch, a key or a token, and a typo is said rather than dropped. A
// version 1 file, whose members each say when they start, is read as the graph that makes; one is always written as
// version 2.
import { CronError, parseCron } from './cron.ts';
import { invalidParams } from './params.ts';
import {
  DEFAULT_GATE_AT_CAP,
  DEFAULT_GATE_CAP,
  DEFAULT_GATE_TIMEOUT,
  MAX_GATE_ROUNDS,
  MAX_PREFAB_TIMEOUT,
  MIN_PREFAB_TIMEOUT,
  PREFAB_INPUT_KINDS,
  PREFAB_JOINS,
  PREFAB_WORKS,
  defaultFresh,
  defaultWorks,
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
  DEFAULT_TICKET_CHAT_KIND,
  TICKET_CHAT_KINDS,
  type CrewPrefab,
  type PrefabGate,
  type PrefabInput,
  type PrefabLine,
  type PrefabMember,
  type PrefabSubagent,
  type PrefabSubagentRuns,
} from './protocol.ts';
import { checkGraph } from './prefab-checks.ts';
import { graphFromStarts, graphOf, roundLimitOf, startsOf, type PrefabGraph } from './prefab-graph.ts';
import { HIDDEN, MAX_WRITES_PATHS, normaliseWritesPath } from './prefab-paths.ts';
import { checkAgentText, checkNamedTemplate } from './role-templates.ts';

/** The file format's version, its first field. A file from a newer app is refused, not half read. */
const FILE_VERSION = 2;
const VERSION_FIELD = 'agentBoardCrewPrefab';

/** A crew prefab file's name ends so: `pair.crew.json`. */
const PREFAB_FILE_SUFFIX = '.crew.json';

/** The longest prefab name, purpose line, subagent name and check line. */
const MAX_PREFAB_NAME_LENGTH = 48;
const MAX_PURPOSE_LENGTH = 200;
const MAX_SUBAGENT_NAME_LENGTH = 24;
const MAX_PATHS = 20;

/** The most inputs, loop gates and lines a prefab has. */
const MAX_INPUTS = 12;
const MAX_GATES = MAX_PREFAB_MEMBERS;
const MAX_LINES = 64;

const PREFAB_FIELDS_V1 = new Set([VERSION_FIELD, 'name', 'icon', 'purpose', 'roundLimit', 'onBoard', 'ticketChat', 'members']);
const PREFAB_FIELDS = new Set([VERSION_FIELD, 'name', 'icon', 'purpose', 'onBoard', 'ticketChat', 'members', 'inputs', 'gates', 'lines']);
const MEMBER_FIELDS_V1 = new Set(['id', 'role', 'name', 'harness', 'model', 'effort', 'template', 'starts', 'subagents']);
const MEMBER_FIELDS = new Set(['id', 'role', 'name', 'harness', 'model', 'effort', 'template', 'brief', 'join', 'timeout', 'fresh', 'works', 'writes', 'rounds', 'subagents']);
const SUBAGENT_FIELDS = new Set(['name', 'checks', 'model', 'access', 'runs']);
const LINE_FIELDS = new Set(['from', 'to', 'carries', 'way', 'lead']);

const MEMBER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ICON = /^[a-z][a-z0-9-]{0,23}$/;

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

/** A whole number from `min` to `max` (no top for `Infinity`), or null when `nullable` and null. `fallback` when absent. */
function whole(fields: Fields, key: string, what: string, min: number, max: number, fallback: number | null | undefined, nullable: boolean): number | null {
  const value = fields[key] === undefined ? fallback : fields[key];
  const range = max === Infinity ? `from ${min}` : `from ${min} to ${max}`;
  const or = nullable ? ', or null for none' : '';
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalidParams(`${what} is a whole number ${range}${or}`);
  return value;
}

/** A timeout in minutes, or null: `MIN_PREFAB_TIMEOUT` to `MAX_PREFAB_TIMEOUT`. */
const timeout = (fields: Fields, what: string, fallback: number | null) =>
  whole(fields, 'timeout', `${what}'s timeout`, MIN_PREFAB_TIMEOUT, MAX_PREFAB_TIMEOUT, fallback, true);

/** An id of a member, input or loop gate: lowercase letters, digits and dashes, at most 24. */
function readId(fields: Fields, what: string): string {
  const id = fields.id;
  if (typeof id !== 'string' || !MEMBER_ID.test(id)) throw invalidParams(`${what}'s id is lowercase letters, digits and dashes, at most 24 (impl, code-review)`);
  return id;
}

/** A list at `fields[key]`: `fallback` when absent, refused when longer than `max`. */
function list(fields: Fields, key: string, what: string, max: number, fallback?: unknown[]): unknown[] {
  const value = fields[key] ?? fallback;
  if (!Array.isArray(value)) throw invalidParams(`${what} must be a list`);
  if (value.length > max) throw invalidParams(`${what} has at most ${max}`);
  return value;
}

function readWrites(value: unknown, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidParams(`${what}'s writes must be a list of paths`);
  // No paths is as good as none given: a member that shares the crew worktree is then refused for having none.
  if (value.length === 0) return undefined;
  if (value.length > MAX_WRITES_PATHS) throw invalidParams(`${what} writes to at most ${MAX_WRITES_PATHS} paths`);
  const paths = value.map((path) => {
    if (typeof path !== 'string') throw invalidParams(`${what}'s writes are paths, as text`);
    const read = normaliseWritesPath(path);
    if ('error' in read) throw invalidParams(`${what}'s writes: ${read.error}`);
    return read.path;
  });
  return [...new Set(paths)];
}

function readInput(value: unknown, index: number): PrefabInput {
  const fields = object(value, `input ${index + 1}`);
  const id = readId(fields, `input ${index + 1}`);
  const what = `input ${id}`;
  const kind = choice(fields, 'kind', `${what}'s kind`, PREFAB_INPUT_KINDS);
  if (kind === 'clock') {
    onlyKnown(fields, new Set(['id', 'kind', 'schedule', 'line']), what);
    const schedule = line(fields, 'schedule', `${what}'s schedule`, 100);
    try {
      parseCron(schedule);
    } catch (error) {
      if (error instanceof CronError) throw invalidParams(`${what}'s schedule: ${error.message}`);
      throw error;
    }
    if (typeof fields.line !== 'string') throw invalidParams(`${what}'s line must be text`);
    checkAgentText(`${what}'s line`, fields.line);
    return { id, kind, schedule, line: fields.line };
  }
  if (kind === 'end') {
    onlyKnown(fields, new Set(['id', 'kind', 'as']), what);
    return { id, kind, as: choice(fields, 'as', `${what}'s as`, ['ready', 'done'] as const, 'ready') };
  }
  onlyKnown(fields, new Set(['id', 'kind']), what);
  return { id, kind };
}

function readGate(value: unknown, index: number): PrefabGate {
  const fields = object(value, `loop gate ${index + 1}`);
  const id = readId(fields, `loop gate ${index + 1}`);
  const what = `loop gate ${id}`;
  const rule = choice(fields, 'rule', `${what}'s rule`, ['done', 'rounds'] as const);
  if (rule === 'rounds') {
    onlyKnown(fields, new Set(['id', 'rule', 'rounds', 'timeout']), what);
    const rounds = whole(fields, 'rounds', `${what}'s rounds`, 1, MAX_GATE_ROUNDS, undefined, false)!;
    return { id, rule, rounds, timeout: timeout(fields, what, DEFAULT_GATE_TIMEOUT) };
  }
  onlyKnown(fields, new Set(['id', 'rule', 'cap', 'atCap', 'timeout']), what);
  return {
    id,
    rule,
    cap: whole(fields, 'cap', `${what}'s cap`, 1, Infinity, DEFAULT_GATE_CAP, true),
    atCap: choice(fields, 'atCap', `what ${what} does at its cap`, ['ask', 'on'] as const, DEFAULT_GATE_AT_CAP),
    timeout: timeout(fields, what, DEFAULT_GATE_TIMEOUT),
  };
}

function readLine(value: unknown, index: number): PrefabLine {
  const fields = object(value, `line ${index + 1}`);
  onlyKnown(fields, LINE_FIELDS, `line ${index + 1}`);
  const end = (key: 'from' | 'to') => {
    const id = fields[key];
    if (typeof id !== 'string' || id === '') throw invalidParams(`line ${index + 1}'s ${key} is the id of a member, input or loop gate`);
    return id;
  };
  const read: PrefabLine = { from: end('from'), to: end('to') };
  const what = `the line ${read.from} → ${read.to}`;
  if (fields.carries !== undefined) read.carries = choice(fields, 'carries', `what ${what} carries`, ['handoff', 'review'] as const);
  if (fields.way !== undefined) read.way = choice(fields, 'way', `${what}'s way`, ['again', 'done'] as const);
  if (fields.lead !== undefined) {
    if (fields.lead !== true) throw invalidParams(`${what}'s lead is true, or left out`);
    read.lead = true;
  }
  return read;
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

/** A member as a file of `version` holds it. A version 2 member's `starts` is read from the lines after. */
function readMember(value: unknown, index: number, version: number): PrefabMember {
  const fields = object(value, `member ${index + 1}`);
  const id = readId(fields, `member ${index + 1}`);
  const what = `member ${id}`;
  onlyKnown(fields, version === 1 ? MEMBER_FIELDS_V1 : MEMBER_FIELDS, what);
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
  const read: PrefabMember = {
    id,
    role,
    name: optionalLine(fields, 'name', `${what}'s name`, MAX_NAME_LENGTH),
    harness,
    model,
    effort,
    template,
    starts: version === 1 ? choice(fields, 'starts', `when ${what} starts`, PREFAB_STARTS, 'prompt') : 'handoff',
    subagents: checks,
  };
  return version === 1 ? read : { ...read, ...readGraphFields(fields, what, role) };
}

/** A version 2 member's own fields, each kept only when it isn't its role's default. */
function readGraphFields(fields: Fields, what: string, role: string | null): Partial<PrefabMember> {
  const read: Partial<PrefabMember> = {};
  if (fields.brief !== undefined && fields.brief !== null) {
    if (typeof fields.brief !== 'string') throw invalidParams(`${what}'s brief must be text`);
    checkAgentText(`${what}'s brief`, fields.brief);
    read.brief = fields.brief;
  }
  const join = choice(fields, 'join', `how ${what} takes its inputs`, PREFAB_JOINS, 'all');
  if (join !== 'all') read.join = join;
  const minutes = timeout(fields, what, null);
  if (minutes !== null && join !== 'all') throw invalidParams(`${what} takes each input as it comes, so it waits for none: leave its timeout out`);
  if (minutes !== null) read.timeout = minutes;
  if (fields.fresh !== undefined && typeof fields.fresh !== 'boolean') throw invalidParams(`${what}'s fresh is true or false`);
  if (fields.fresh !== undefined && fields.fresh !== defaultFresh(role)) read.fresh = fields.fresh as boolean;
  const works = choice(fields, 'works', `the branch ${what} works on`, PREFAB_WORKS, defaultWorks(role));
  if (works !== defaultWorks(role)) read.works = works;
  const writes = readWrites(fields.writes, what);
  if (writes !== undefined) read.writes = writes;
  return read;
}

/** A version 2 prefab's graph, as its file holds it. */
function readGraph(fields: Fields): PrefabGraph {
  return {
    inputs: list(fields, 'inputs', "the prefab's inputs", MAX_INPUTS).map(readInput),
    gates: list(fields, 'gates', "the prefab's loop gates", MAX_GATES, []).map(readGate),
    lines: list(fields, 'lines', "the prefab's lines", MAX_LINES).map(readLine),
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
/** Checks how work passes between a prefab's members. A ticket's chat (`ticket`) leads as an orchestrator does. */
function checkFlow(members: PrefabMember[], ticket: boolean, version: number) {
  // A version 2 file says it in lines: the starts here are read back from them.
  const v1 = version === 1;
  const first = members.filter((member) => member.starts === 'prompt');
  if (first.length !== 1) {
    throw invalidParams(
      v1
        ? `a crew has one member that starts on the prompt, its builder or its lead; this one has ${first.length}`
        : `a crew has one member on a line from Your prompt, its builder or its lead, for now; this one has ${first.length}`,
    );
  }
  const lead = ticket || isOrchestratorRole(first[0]!.role);
  for (const member of members) {
    // A version 1 file's hand-off is a builder's, to its reviewers; a version 2 file's lines may take work to anyone.
    if (v1 && member.starts === 'handoff' && !REVIEWER_ROLES.includes(member.role as never)) {
      throw invalidParams(`${member.id} starts at the hand-off, so it is a reviewer or follow-up reviewer, which reviews the builder's branch`);
    }
    if (member.starts === 'handoff' && lead) {
      throw invalidParams(
        v1
          ? `${member.id} starts at the hand-off, but a crew with a lead has the lead start its reviewers: start it by the lead`
          : `${member.id} is on a line from another member, but a crew with a lead has the lead start its members: draw a lead line to it`,
      );
    }
    if (member.starts === 'lead' && !lead) {
      throw invalidParams(
        v1
          ? `${member.id} is started by the lead, so the member that starts on the prompt is an orchestrator, or the prefab is a ticket`
          : `${member.id} is on a lead line, so the member on the line from Your prompt is an orchestrator, or the prefab is a ticket`,
      );
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
  onlyKnown(fields, version === 1 ? PREFAB_FIELDS_V1 : PREFAB_FIELDS, 'a crew prefab');
  const name = line(fields, 'name', "the prefab's name", MAX_PREFAB_NAME_LENGTH);
  if (name === '') throw invalidParams('a crew prefab needs a name');
  const icon = fields.icon ?? 'crew';
  if (typeof icon !== 'string' || !ICON.test(icon)) throw invalidParams("the prefab's icon is a name in lowercase letters, digits and dashes");
  const members = fields.members;
  if (!Array.isArray(members) || members.length === 0) throw invalidParams('a crew prefab has at least one member');
  if (members.length > MAX_PREFAB_MEMBERS) throw invalidParams(`a crew prefab has at most ${MAX_PREFAB_MEMBERS} members`);
  const onBoard = choice(fields, 'onBoard', 'onBoard', ['card', 'tiles', 'ticket'] as const, 'card');
  let read = members.map((each, n) => readMember(each, n, version));
  const twice = read.find((member, n) => read.findIndex((other) => other.id === member.id) !== n);
  if (twice !== undefined) throw invalidParams(`two members are ${twice.id}: each has an id of its own`);
  let roundLimit: number;
  let graph: PrefabGraph;
  if (version === 1) {
    roundLimit = whole(fields, 'roundLimit', 'the round limit', 1, MAX_REVIEW_CAP, DEFAULT_PREFAB_ROUND_LIMIT, false)!;
    checkFlow(read, onBoard === 'ticket', version);
    graph = graphFromStarts({ members: read, roundLimit, onBoard });
    checkGraph(read, graph, onBoard);
  } else {
    graph = readGraph(fields);
    checkGraph(read, graph, onBoard);
    read = read.map((member) => ({ ...member, starts: startsOf(member.id, graph) }));
    // What the board runs a crew by today: one member started on the prompt, with reviewers at its hand-off or a lead.
    checkFlow(read, onBoard === 'ticket', version);
    roundLimit = graph.gates.length > 0 ? roundLimitOf(graph.gates) : DEFAULT_PREFAB_ROUND_LIMIT;
    const lead = leadOf(read, onBoard, graph.gates);
    members.forEach((each, n) => {
      const member = read[n]!;
      if ((each as Fields).rounds === undefined) return;
      if (graph.gates.length > 0) throw invalidParams(`${member.id} has rounds, but this crew's loop gates hold its limits: leave rounds out`);
      if (member !== lead) throw invalidParams(`${member.id} has rounds, which only a crew's lead has (the orchestrator, or a ticket's chat, on a line from Your prompt)`);
      roundLimit = whole(each as Fields, 'rounds', `${member.id}'s rounds`, 1, MAX_REVIEW_CAP, undefined, false)!;
    });
  }
  checkTemplates(read);
  if (fields.ticketChat !== undefined && onBoard !== 'ticket') throw invalidParams('only a prefab that starts inside a ticket tile has a ticket chat');
  const ticketChat = fields.ticketChat === undefined ? undefined : choice(fields, 'ticketChat', 'ticketChat', TICKET_CHAT_KINDS);
  return {
    name,
    icon,
    purpose: line(fields, 'purpose', "the prefab's purpose", MAX_PURPOSE_LENGTH, ''),
    roundLimit,
    onBoard,
    ...(ticketChat === undefined ? {} : { ticketChat }),
    members: read,
    ...graph,
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

/**
 * A crew's lead, whose own `rounds` hold the crew's round limit: the member on the prompt, when it is an orchestrator or
 * a ticket's chat and no loop gate holds the limit. Else none.
 */
function leadOf(members: readonly PrefabMember[], onBoard: CrewPrefab['onBoard'], gates: readonly PrefabGate[]): PrefabMember | undefined {
  const first = members.find((member) => member.starts === 'prompt');
  if (first === undefined || gates.length > 0) return undefined;
  return onBoard === 'ticket' || isOrchestratorRole(first.role) ? first : undefined;
}

/** A member as its file holds it: every field written out, its role's defaults filled in, and no `starts`. A lead's `rounds` too. */
function memberFile(member: PrefabMember, rounds?: number) {
  const { id, role, name, harness, model, effort, template, subagents } = member;
  const join = member.join ?? 'all';
  return {
    id,
    role,
    name,
    harness,
    model,
    effort,
    template,
    brief: member.brief ?? null,
    join,
    timeout: join === 'all' ? (member.timeout ?? null) : null,
    fresh: member.fresh ?? defaultFresh(role),
    works: member.works ?? defaultWorks(role),
    writes: member.writes ?? null,
    ...(rounds === undefined ? {} : { rounds }),
    subagents,
  };
}

/**
 * `prefab` as a `.crew.json` file's text (version 2), every field written out, its version first. A prefab built or
 * changed by when its members start is written as the graph those make (`graphOf`).
 */
export function prefabFile(prefab: CrewPrefab): string {
  const { name, icon, purpose, onBoard, ticketChat, members } = prefab;
  const { inputs, gates, lines } = graphOf(prefab);
  const lead = leadOf(members, onBoard, gates);
  const chat = onBoard === 'ticket' ? { ticketChat: ticketChat ?? DEFAULT_TICKET_CHAT_KIND } : {};
  return `${JSON.stringify({ [VERSION_FIELD]: FILE_VERSION, name, icon, purpose, onBoard, ...chat, members: members.map((member) => memberFile(member, member === lead ? prefab.roundLimit : undefined)), inputs, gates, lines }, null, 2)}\n`;
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

const PROMPT: PrefabInput = { id: 'prompt', kind: 'prompt' };
const TICKET: PrefabInput = { id: 'ticket', kind: 'ticket' };
const READY: PrefabInput = { id: 'end', kind: 'end', as: 'ready' };
/** A built-in's loop gate: until its reviewers approve, at most `cap` rounds, then it asks; no timeout. */
const loop = (cap: number): PrefabGate => ({ id: 'loop', rule: 'done', cap, atCap: 'ask', timeout: null });
const to = (from: string, target: string, more: Omit<PrefabLine, 'from' | 'to'> = {}): PrefabLine => ({ from, to: target, ...more });
/** A builder and its reviewers, round its loop gate until they approve, then Ready. */
const reviewed = (builder: string, reviewers: string[]): PrefabLine[] => [
  to('prompt', builder),
  ...reviewers.map((reviewer) => to(builder, reviewer, { carries: 'handoff' })),
  ...reviewers.map((reviewer) => to(reviewer, 'loop', { carries: 'review' })),
  to('loop', builder, { way: 'again' }),
  to('loop', 'end', { way: 'done' }),
];
/** A ticket's chat, on its prompt and ticket, starting each of `crew` itself, then Ready. */
const ticketLed = (chat: string, crew: string[]): PrefabLine[] => [
  to('prompt', chat),
  to('ticket', chat),
  ...crew.map((each) => to(chat, each, { lead: true })),
  to(chat, 'end'),
];

/** The app's own prefabs, in the library's order. None can be saved over: save a copy under a name of its own. */
export const BUILT_IN_PREFABS: readonly CrewPrefab[] = [
  prefab({
    name: 'Solo agent',
    icon: 'agent',
    purpose: 'One agent, as New agent starts it',
    members: [member({ id: 'agent', role: null, starts: 'prompt' })],
    inputs: [PROMPT, READY],
    gates: [],
    lines: [to('prompt', 'agent'), to('agent', 'end')],
  }),
  prefab({
    name: 'Implementer + reviewer',
    icon: 'review',
    purpose: 'One builds; a reviewer checks each hand-off until it approves',
    members: [member({ id: 'impl', role: 'implementer', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
    inputs: [PROMPT, READY],
    gates: [loop(3)],
    lines: reviewed('impl', ['review']),
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
    inputs: [PROMPT, READY],
    gates: [loop(3)],
    lines: reviewed('impl', ['code-review', 'design-review']),
  }),
  prefab({
    name: 'Spike + reviewer',
    icon: 'spike',
    purpose: 'A quick spike to answer a question, then a review of what it found',
    roundLimit: 1,
    members: [member({ id: 'spike', role: 'spike', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'handoff' })],
    inputs: [PROMPT, READY],
    gates: [loop(1)],
    lines: reviewed('spike', ['review']),
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
    inputs: [PROMPT, READY],
    gates: [],
    lines: [to('prompt', 'lead'), to('lead', 'impl', { lead: true }), to('lead', 'review', { lead: true }), to('lead', 'end')],
  }),
  prefab({
    name: 'Ticket',
    icon: 'ticket',
    purpose: 'One chat for a ticket: it builds, and starts and runs its helpers (designer, builder, reviewer)',
    onBoard: 'ticket',
    ticketChat: 'implementer',
    members: [member({ id: 'chat', role: 'implementer', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', starts: 'lead' })],
    inputs: [PROMPT, TICKET, READY],
    gates: [],
    lines: ticketLed('chat', ['review']),
  }),
  prefab({
    name: 'Design, build, review',
    icon: 'ticket',
    purpose: 'A ticket whose chat leads: a designer, then a builder, then a reviewer',
    onBoard: 'ticket',
    ticketChat: 'lead',
    members: [
      member({ id: 'chat', role: 'orchestrator', starts: 'prompt' }),
      member({ id: 'design', role: 'designer', name: 'design', model: 'opus', effort: 'high', starts: 'lead' }),
      member({ id: 'build', role: 'implementer', name: 'builder', model: 'opus', effort: 'medium', starts: 'lead' }),
      member({ id: 'review', role: 'reviewer', name: 'review', model: 'opus', effort: 'medium', starts: 'lead' }),
    ],
    inputs: [PROMPT, TICKET, READY],
    gates: [],
    lines: ticketLed('chat', ['design', 'build', 'review']),
  }),
  prefab({
    name: 'Just the chat',
    icon: 'ticket',
    purpose: 'A ticket with its chat alone: it builds, and starts any helper it needs',
    onBoard: 'ticket',
    ticketChat: 'implementer',
    members: [member({ id: 'chat', role: 'implementer', starts: 'prompt' })],
    inputs: [PROMPT, TICKET, READY],
    gates: [],
    lines: ticketLed('chat', []),
  }),
];
