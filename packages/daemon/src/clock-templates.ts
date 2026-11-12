/**
 * Clock templates (ADR-0017): clocks saved under a name, for every zone, to start new ones from. The user saves them
 * from the editor and agents through `schedule template` or the MCP; an agent removes, or replaces, only its own.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, connectionAgent, isOwnLiveSession, type ActivityLogger, type BoardCallerSources, type BoardConnection } from './board.ts';
import { newClockData } from './clocks.ts';
import type { Clock } from './clock.ts';
import { checkedData } from './items.ts';
import { isObject } from './json.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  CLOCK_TEMPLATE_KEYS,
  MAX_CLOCK_TEMPLATE_NAME,
  MAX_CLOCK_TEMPLATES,
  MAX_CLOCK_TEMPLATES_PER_AGENT,
  type Agent,
  type ClockData,
  type ClockTemplate,
  type ClockTemplateData,
  type DaemonEvent,
  type DaemonMethods,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type TemplateMethods = Pick<DaemonMethods, 'clockTemplate.list' | 'clockTemplate.save' | 'clockTemplate.remove'>;

export interface ClockTemplateHostOptions {
  db: DatabaseSync;
  clock: Clock;
  broadcast(event: DaemonEvent): void;
}

/** Who calls, and the activity log an agent's saves and removals go in. */
export interface ClockTemplateSources extends BoardCallerSources {
  logActivity?: ActivityLogger;
}

export interface ClockTemplateHost {
  /** The data of the template `ref` names, by id or name; throws `invalidParams` for none. */
  dataOf(ref: string): ClockTemplateData;
  handlers<Context extends BoardConnection>(sources: ClockTemplateSources): RpcHandlers<TemplateMethods, Context>;
}

interface TemplateRow {
  id: string;
  name: string;
  data: string;
  made_by: string | null;
  created_at: string;
  updated_at: string;
}

const templateOf = (row: TemplateRow): ClockTemplate => ({
  id: row.id,
  name: row.name,
  data: JSON.parse(row.data) as ClockTemplateData,
  madeBy: row.made_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The keys of `data` a template keeps, checked as a clock's are. */
function templateData(data: Partial<ClockData>): ClockTemplateData {
  const full = { ...newClockData(), ...data, agent: null, handoffTo: null };
  if (full.result === 'handoff') throw invalidParams("a template can't name the agent a hand-off goes to: give its result as history or note");
  const checked = JSON.parse(checkedData('clock', full as unknown as Record<string, unknown>)) as ClockData;
  const kept: Record<string, unknown> = {};
  for (const key of CLOCK_TEMPLATE_KEYS) if (checked[key] !== undefined) kept[key] = checked[key];
  return kept as ClockTemplateData;
}

export function createClockTemplateHost(options: ClockTemplateHostOptions): ClockTemplateHost {
  const { db } = options;
  const selectAll = db.prepare('SELECT * FROM clock_templates ORDER BY name COLLATE NOCASE');
  const selectRef = db.prepare('SELECT * FROM clock_templates WHERE id = ? OR name = ? COLLATE NOCASE');
  const selectName = db.prepare('SELECT * FROM clock_templates WHERE name = ? COLLATE NOCASE');
  const selectClock = db.prepare("SELECT data FROM board_items WHERE kind = 'clock' AND id = ?");
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM clock_templates');
  const countBy = db.prepare('SELECT COUNT(*) AS n FROM clock_templates WHERE made_by = ?');
  const insert = db.prepare('INSERT INTO clock_templates (id, name, data, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const replace = db.prepare('UPDATE clock_templates SET name = ?, data = ?, made_by = ?, updated_at = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM clock_templates WHERE id = ?');

  const list = (): ClockTemplate[] => (selectAll.all() as unknown as TemplateRow[]).map(templateOf);
  const find = (ref: string): ClockTemplate => {
    const row = selectRef.get(ref, ref) as TemplateRow | undefined;
    if (row === undefined) throw invalidParams(`no clock template ${ref}`);
    return templateOf(row);
  };
  /** Throws if one more template would be too many: of the agent's (`madeBy`), or of all. */
  const roomFor = (madeBy: string | null) => {
    const removeOne = 'remove one with `agent-board schedule template remove <name>`, or save over one of yours';
    if (madeBy !== null) {
      const mine = (countBy.get(madeBy) as { n: number }).n;
      if (mine >= MAX_CLOCK_TEMPLATES_PER_AGENT) throw invalidParams(`you have saved ${mine} clock templates, the most an agent may: ${removeOne}`);
    }
    const all = (countAll.get() as { n: number }).n;
    if (all >= MAX_CLOCK_TEMPLATES) throw invalidParams(`there are ${all} clock templates, the most the board keeps: ${removeOne}`);
  };

  /** Saves the template `name`, new or over one `me` may change, from `p`'s data or clock. */
  const save = (p: Record<string, unknown>, me: Agent | undefined, name: string, mayChange: (me: Agent | undefined, template: ClockTemplate) => void): ClockTemplate => {
    if (name === '') throw invalidParams('give the template a name');
    if (name.length > MAX_CLOCK_TEMPLATE_NAME) throw invalidParams(`a template's name is over ${MAX_CLOCK_TEMPLATE_NAME} characters`);
    const fromClock = optionalStringParam(p, 'fromClock');
    let data: ClockTemplateData;
    if (fromClock !== undefined) {
      if (p.data !== undefined) throw invalidParams('give data or fromClock, not both');
      const row = selectClock.get(fromClock) as { data: string } | undefined;
      if (row === undefined) throw invalidParams(`no clock ${fromClock}`);
      const clock = JSON.parse(row.data) as ClockData;
      if (clock.result === 'handoff') {
        throw invalidParams('that clock hands its result to an agent, which a template never names: save it with its cron and prompt and --result history|note');
      }
      data = templateData(clock);
    } else {
      if (!isObject(p.data)) throw invalidParams('give the template its data, or fromClock');
      data = templateData(p.data as Partial<ClockData>);
    }
    if (data.prompt.trim() === '') throw invalidParams('give the template its prompt');
    const now = new Date(options.clock.now()).toISOString();
    const madeBy = me?.sessionId ?? null;
    const existing = selectName.get(name) as TemplateRow | undefined;
    let id: string;
    if (existing === undefined) {
      roomFor(madeBy);
      id = randomUUID();
      insert.run(id, name, JSON.stringify(data), madeBy, now, now);
    } else {
      mayChange(me, templateOf(existing));
      id = existing.id;
      replace.run(name, JSON.stringify(data), madeBy, now, id);
    }
    const template = find(id);
    // Only the one saved: a client keeps the rest from `clockTemplate.list`.
    options.broadcast({ type: 'clockTemplate.updated', template });
    return template;
  };

  return {
    dataOf: (ref) => find(ref).data,

    handlers<Context extends BoardConnection>(sources: ClockTemplateSources): RpcHandlers<TemplateMethods, Context> {
      /** The agent the call is from, as its own live session; undefined for the user's side (the app, a shell). */
      const maker = (p: Record<string, unknown>, connection: BoardConnection): Agent | undefined => {
        const ended = () => invalidParams("an ended agent's session can't save or remove templates");
        const token = optionalStringParam(p, 'token');
        if (token === undefined) {
          const agent = connectionAgent(sources, connection);
          if (agent === null) throw invalidParams('unknown board session: its agent is gone');
          if (agent !== undefined && (connection.boardSession === undefined || !isOwnLiveSession(agent, connection.boardSession))) throw ended();
          return agent;
        }
        const who = boardCaller(sources, token, connection);
        if (who.kind !== 'agent' || who.side !== 'agent') return undefined;
        const agent = sources.agents.get(who.tileId) as Agent | undefined;
        if (agent === undefined || !isOwnLiveSession(agent, who.sessionId)) throw ended();
        return agent;
      };
      /** Throws unless `me` may change the template: the user any, an agent only one it saved. */
      const mayChange = (me: Agent | undefined, template: ClockTemplate) => {
        if (me !== undefined && template.madeBy !== me.sessionId) {
          throw invalidParams(`the template ${template.name} isn't one you saved: save yours under another name`);
        }
      };
      /** Runs `change` and, for an agent, writes it to the activity log, or why it was refused. */
      const logged = <T>(me: Agent | undefined, action: 'save-clock-template' | 'remove-clock-template', name: string, change: () => T): T => {
        if (me === undefined || sources.logActivity === undefined) return change();
        const entry = { on: { id: `clock-template:${name}`, name }, detail: name };
        try {
          const done = change();
          sources.logActivity(me, action, entry);
          return done;
        } catch (error) {
          sources.logActivity(me, action, entry, (error as Error).message);
          throw error;
        }
      };
      return {
        'clockTemplate.list': () => list(),
        'clockTemplate.save': (params, connection) => {
          const p = paramsObject(params);
          const me = maker(p, connection);
          const name = stringParam(p, 'name').trim();
          return logged(me, 'save-clock-template', name, () => save(p, me, name, mayChange));
        },
        'clockTemplate.remove': (params, connection) => {
          const p = paramsObject(params);
          const me = maker(p, connection);
          const ref = stringParam(p, 'template').trim();
          return logged(me, 'remove-clock-template', ref, () => {
            const template = find(ref);
            mayChange(me, template);
            remove.run(template.id);
            options.broadcast({ type: 'clockTemplate.removed', id: template.id });
            return null;
          });
        },
      };
    },
  };
}
