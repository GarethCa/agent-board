// What a document is, by its file: its format by its extension, and its title by its text. Pure, for the daemon and
// the board MCP alike.
import { basename, extname } from 'node:path';
import { DOCUMENT_EXTENSIONS, MAX_PLAN_TITLE_LENGTH, type PlanFormat } from './protocol.ts';

/** The format of a file by its extension, or undefined for one that is neither Markdown nor HTML. */
export function documentFormat(path: string): PlanFormat | undefined {
  const ext = extname(path).toLowerCase();
  return (Object.keys(DOCUMENT_EXTENSIONS) as PlanFormat[]).find((format) => DOCUMENT_EXTENSIONS[format].includes(ext));
}

/** What a document is called when its agent gave no title: its first heading, or its page's title; else its file's name. */
export function documentTitle(path: string, format: PlanFormat, text: string): string {
  const found = format === 'markdown' ? /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1] : /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
  const title = found?.replace(/\s+/g, ' ').trim();
  return title === undefined || title === '' ? basename(path) : title.slice(0, MAX_PLAN_TITLE_LENGTH);
}
