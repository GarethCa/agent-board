// An agent's page: what it writes for the default shelf of its sidebar, from building blocks (a heading with its
// progress, key figures, a checklist, a callout, links, a note), each with an icon and a tone it picks from the board's
// curated sets. Kept per agent in `agent_records`, as its one row of kind `page`.
import type { DatabaseSync } from 'node:sqlite';
import { linkTarget, realFile } from './agent-records.ts';
import { isObject } from './json.ts';
import { invalidParams } from './params.ts';
import {
  MAX_FIGURE_VALUE,
  MAX_PAGE_BLOCKS,
  MAX_PAGE_FIGURES,
  MAX_PAGE_ITEM,
  MAX_PAGE_ITEMS,
  MAX_PAGE_NAME,
  MAX_PAGE_TEXT,
  MAX_PAGE_TITLE,
  PAGE_BLOCK_KINDS,
  PAGE_CHECK_STATES,
  PAGE_ICONS,
  PAGE_TONES,
  type AgentPage,
  type PageBlock,
  type PageCheckState,
  type PageIcon,
  type PageLink,
  type PageTone,
  type PinTarget,
} from './protocol.ts';

/** The page's row in `agent_records`: an agent has one page, so one key. A daemon that doesn't know the kind leaves it alone. */
const PAGE_KIND = 'page';
const PAGE_KEY = 'page';
/** The icon a stored page's tab gets when its own is one this daemon doesn't offer (a later daemon's). */
const FALLBACK_ICON: PageIcon = 'compass';

export interface AgentPageStore {
  /** The agent's page; undefined for none, or one this daemon can't read. */
  of(sessionId: string): AgentPage | undefined;
  /** Writes the agent's page, replacing the one it had; the page as stored. */
  put(sessionId: string, page: Omit<AgentPage, 'writtenAt'>): AgentPage;
  /** Clears the agent's page; false when it had none. */
  clear(sessionId: string): boolean;
}

export function createAgentPageStore(db: DatabaseSync): AgentPageStore {
  const selectOne = db.prepare('SELECT data, recorded_at FROM agent_records WHERE session_id = ? AND kind = ? AND key = ?');
  const upsert = db.prepare(
    `INSERT INTO agent_records (session_id, kind, key, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, kind, key) DO UPDATE SET data = excluded.data, deleted_at = NULL,
       recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const deleteOne = db.prepare('DELETE FROM agent_records WHERE session_id = ? AND kind = ? AND key = ?');
  const of = (sessionId: string): AgentPage | undefined => {
    const row = selectOne.get(sessionId, PAGE_KIND, PAGE_KEY) as { data: string; recorded_at: string } | undefined;
    if (row === undefined) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      return undefined;
    }
    return storedPage(data, row.recorded_at);
  };
  return {
    of,
    put(sessionId, page) {
      upsert.run(sessionId, PAGE_KIND, PAGE_KEY, JSON.stringify(page));
      return of(sessionId)!;
    },
    clear: (sessionId) => deleteOne.run(sessionId, PAGE_KIND, PAGE_KEY).changes > 0,
  };
}

/**
 * How a page is read: as an agent writes it, every field checked and a link's file from `cwd`; or as it was stored,
 * where what this daemon doesn't know (a later one's icon, tone or field) is let go rather than refused.
 */
type Source = { cwd: string } | 'stored';

/**
 * `board.setPage`'s `page`, checked, as it is stored: its name trimmed, each block with its title, icon and tone (or
 * none, neutral), and a link's file by its real path from `cwd`, where the caller's session started. Refused with a
 * message naming the block and field, so an agent can fix the one thing.
 */
export function pageFor(cwd: string, page: unknown): Omit<AgentPage, 'writtenAt'> {
  if (!isObject(page)) throw invalidParams('page must be an object of name, icon and blocks, or null to clear it');
  const source = { cwd };
  onlyKeys(page, ['name', 'icon', 'blocks'], 'page', source);
  const name = text(page, 'name', 'page', MAX_PAGE_NAME, source);
  const icon = iconOf(page.icon, 'page', source);
  if (icon === null) throw invalidParams(`page: icon must be one of ${PAGE_ICONS.join(', ')}`);
  if (!Array.isArray(page.blocks) || page.blocks.length === 0) throw invalidParams('page: blocks must be a list of at least one block');
  if (page.blocks.length > MAX_PAGE_BLOCKS) throw invalidParams(`page: at most ${MAX_PAGE_BLOCKS} blocks`);
  return { name, icon, blocks: page.blocks.map((block, index) => blockFor(block, `block ${index + 1}`, source)) };
}

/**
 * A stored page, as this daemon reads it; undefined for one it can't, or one with no block it can draw. Each block is
 * read as a written one is checked, so what reaches a window always has the shape it draws: a block of a kind or shape
 * this daemon doesn't know is left out, an icon it doesn't offer is none (the tab's, `FALLBACK_ICON`), a tone neutral.
 */
function storedPage(data: unknown, writtenAt: string): AgentPage | undefined {
  if (!isObject(data) || typeof data.name !== 'string' || !Array.isArray(data.blocks)) return undefined;
  const blocks = data.blocks.flatMap((block) => {
    try {
      return [blockFor(block, 'stored block', 'stored')];
    } catch {
      return [];
    }
  });
  if (blocks.length === 0) return undefined;
  return { name: data.name, icon: iconOf(data.icon, 'page', 'stored') ?? FALLBACK_ICON, blocks, writtenAt };
}

/** The fields each kind of block takes, besides `kind`, `title`, `icon` and `tone`. */
const BLOCK_FIELDS: Record<PageBlock['kind'], readonly string[]> = {
  heading: ['text', 'progress'],
  figures: ['figures'],
  checklist: ['items'],
  callout: ['text'],
  links: ['links'],
  note: ['text'],
};

function blockFor(block: unknown, where: string, source: Source): PageBlock {
  if (!isObject(block)) throw invalidParams(`${where} must be an object with a kind`);
  const kind = block.kind as PageBlock['kind'];
  if (!(PAGE_BLOCK_KINDS as readonly unknown[]).includes(kind)) throw invalidParams(`${where}: kind must be one of ${PAGE_BLOCK_KINDS.join(', ')}`);
  const at = `${where} (${kind})`;
  onlyKeys(block, ['kind', 'title', 'icon', 'tone', ...BLOCK_FIELDS[kind]], at, source);
  const titled = kind === 'heading' || kind === 'note';
  const base = {
    title: titled ? text(block, 'title', at, MAX_PAGE_TITLE, source) : optionalText(block, 'title', at, MAX_PAGE_TITLE, source),
    icon: iconOf(block.icon, at, source),
    tone: toneOf(block.tone, at, source),
  };
  switch (kind) {
    case 'heading':
      return { ...base, kind, text: optionalText(block, 'text', at, MAX_PAGE_TEXT, source, true), progress: progressOf(block.progress, at) };
    case 'callout':
    case 'note':
      return { ...base, kind, text: text(block, 'text', at, MAX_PAGE_TEXT, source, true) };
    case 'figures':
      return {
        ...base,
        kind,
        figures: listOf(block, 'figures', at, MAX_PAGE_FIGURES).map((figure, index) => {
          const of = `${at}, figure ${index + 1}`;
          if (!isObject(figure)) throw invalidParams(`${of} must be an object of value and label`);
          onlyKeys(figure, ['value', 'label', 'icon', 'tone'], of, source);
          return {
            value: text(figure, 'value', of, MAX_FIGURE_VALUE, source),
            label: text(figure, 'label', of, MAX_PAGE_ITEM, source),
            icon: iconOf(figure.icon, of, source),
            tone: toneOf(figure.tone, of, source),
          };
        }),
      };
    case 'checklist': {
      const items = listOf(block, 'items', at, MAX_PAGE_ITEMS).map((item, index) => {
        const of = `${at}, item ${index + 1}`;
        if (!isObject(item)) throw invalidParams(`${of} must be an object of text and state`);
        onlyKeys(item, ['text', 'state'], of, source);
        return { text: text(item, 'text', of, MAX_PAGE_ITEM, source), state: stateOf(item.state, of, source) };
      });
      if (source !== 'stored' && items.filter((item) => item.state === 'doing').length > 1) throw invalidParams(`${at}: at most one item is doing`);
      return { ...base, kind, items };
    }
    case 'links':
      return { ...base, kind, links: listOf(block, 'links', at, MAX_PAGE_ITEMS).map((link, index) => linkFor(link, `${at}, link ${index + 1}`, source)) };
  }
}

/**
 * A links block's row: exactly one of a URL a web tab opens and a file, as a pin's are checked. A stored one is
 * as it was kept, by its target.
 */
function linkFor(link: unknown, where: string, source: Source): PageLink {
  if (!isObject(link)) throw invalidParams(`${where} must be an object of url or path, and label`);
  if (source === 'stored') {
    const { target } = link;
    const label = optionalText(link, 'label', where, MAX_PAGE_ITEM, source);
    if (isObject(target) && target.kind === 'link' && typeof target.url === 'string') return { target: { kind: 'link', url: target.url }, label };
    if (isObject(target) && target.kind === 'file' && typeof target.path === 'string') return { target: { kind: 'file', path: target.path }, label };
    throw invalidParams(`${where}: no target`);
  }
  onlyKeys(link, ['url', 'path', 'label'], where, source);
  const label = optionalText(link, 'label', where, MAX_PAGE_ITEM, source);
  const { url, path } = link;
  if ((url === undefined) === (path === undefined)) throw invalidParams(`${where}: give one of url and path`);
  if (url !== undefined && typeof url !== 'string') throw invalidParams(`${where}: url must be a string`);
  if (path !== undefined && typeof path !== 'string') throw invalidParams(`${where}: path must be a string`);
  let target: PinTarget;
  try {
    target = url === undefined ? { kind: 'file', path: realFile(source.cwd, path as string) } : linkTarget(url as string);
  } catch (error) {
    throw invalidParams(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (target.kind === 'note') throw invalidParams(`${where}: give one of url and path`);
  return { target, label };
}

/** Refuses a field of `fields` not in `known`, so a misspelt or misplaced one isn't lost quietly; a stored one is let go. */
function onlyKeys(fields: Record<string, unknown>, known: readonly string[], where: string, source: Source): void {
  if (source === 'stored') return;
  const unknown = Object.keys(fields).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw invalidParams(`${where}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} here; it takes ${known.join(', ')}`);
}

/** Field `name` of `fields`: a string, trimmed, not blank, at most `max` characters. */
function text(fields: Record<string, unknown>, name: string, where: string, max: number, source: Source, lines = false): string {
  const value = optionalText(fields, name, where, max, source, lines);
  if (value === null) throw invalidParams(`${where}: ${name} must not be empty`);
  return value;
}

/**
 * As `text`, but absent or blank is null. With `lines` (a block's text) it keeps its line breaks; else it is one line.
 * Characters are counted as the eye counts them (an emoji, an accented letter, one each), after NFC.
 */
function optionalText(fields: Record<string, unknown>, name: string, where: string, max: number, source: Source, lines = false): string | null {
  const value = fields[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`${where}: ${name} must be a string`);
  if (source === 'stored') return value === '' ? null : value;
  const kept = (lines ? value.replace(/\r\n?/g, '\n') : value.replace(/\s+/g, ' ')).replace(UNSEEN, (each) => (UNSEEN_KEPT.has(each) ? each : '')).trim().normalize('NFC');
  if (characters(kept) > max) throw invalidParams(`${where}: ${name} is at most ${max} characters`);
  return kept === '' ? null : kept;
}

/**
 * Characters taken out of an agent's text: control characters bar a line break and a tab, and the bidi controls,
 * which would turn round what the sidebar draws after them. Joiners stay, for the emoji made with them.
 */
const UNSEEN = /[\p{Cc}\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/gu;
const UNSEEN_KEPT = new Set(['\n', '\t']);

const segmenter = new Intl.Segmenter();
const characters = (value: string): number => [...segmenter.segment(value)].length;

function listOf(fields: Record<string, unknown>, name: string, where: string, max: number): unknown[] {
  const value = fields[name];
  if (!Array.isArray(value) || value.length === 0) throw invalidParams(`${where}: ${name} must be a list of at least one`);
  if (value.length > max) throw invalidParams(`${where}: at most ${max} ${name}`);
  return value;
}

function iconOf(value: unknown, where: string, source: Source): PageIcon | null {
  if (value === undefined || value === null) return null;
  if ((PAGE_ICONS as readonly unknown[]).includes(value)) return value as PageIcon;
  if (source === 'stored') return null;
  throw invalidParams(`${where}: icon must be one of ${PAGE_ICONS.join(', ')}`);
}

function toneOf(value: unknown, where: string, source: Source): PageTone {
  if (value === undefined || value === null) return 'neutral';
  if ((PAGE_TONES as readonly unknown[]).includes(value)) return value as PageTone;
  if (source === 'stored') return 'neutral';
  throw invalidParams(`${where}: tone must be one of ${PAGE_TONES.join(', ')}`);
}

function stateOf(value: unknown, where: string, source: Source): PageCheckState {
  if (value === undefined || value === null) return 'todo';
  if ((PAGE_CHECK_STATES as readonly unknown[]).includes(value)) return value as PageCheckState;
  if (source === 'stored') return 'todo';
  throw invalidParams(`${where}: state must be one of ${PAGE_CHECK_STATES.join(', ')}`);
}

function progressOf(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) throw invalidParams(`${where}: progress must be a whole number from 0 to 100`);
  return value as number;
}
