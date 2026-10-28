import { isAbsolute, relative } from 'node:path';
import type { HarnessName } from './paths.ts';
import { toolOutput } from './tool-output.ts';

/**
 * What the `demo-*` scenarios print: a terminal that looks like the real Claude Code or Codex TUI, for videos and
 * screenshots. Display only: hooks and transcripts get the plain text and the tools' real inputs and responses.
 */

const paint = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const CLAUDE_ORANGE = '38;2;215;119;87';
const BOLD = '1';
const DIM = '2';
const GREEN = '32';
const DIFF_REMOVED = '38;2;255;220;220;48;2;122;41;54';
const DIFF_ADDED = '38;2;220;255;220;48;2;34;92;43';

/** How many lines of a tool's output it shows before folding the rest away, as the TUIs do. */
const SHOWN_OUTPUT_LINES = 4;

/** The frames of Claude's thinking spinner, in order. */
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];

/** Where a session runs, as the TUIs show it: under the home folder as `~`. */
export function shownPath(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * `lines` in a rounded box, its border painted `border`, with `title` in its top edge; centred with `centre`. The lines
 * are plain text, so their widths are their lengths.
 */
function box(lines: string[], border: string, { title, centre = false }: { title?: string; centre?: boolean } = {}): string[] {
  const width = Math.max(...lines.map((line) => line.length), (title?.length ?? 0) + 6) + 2;
  const edge = (text: string) => paint(border, text);
  const top = title === undefined ? '─'.repeat(width) : `─── ${title} ${'─'.repeat(width - title.length - 5)}`;
  const fit = (line: string) => (centre ? line.padStart(Math.floor((width - 2 + line.length) / 2)) : line).padEnd(width - 2);
  return [edge(`╭${top}╮`), ...lines.map((line) => `${edge('│')} ${fit(line)} ${edge('│')}`), edge(`╰${'─'.repeat(width)}╯`)];
}

/** Claude's mascot, as its welcome box draws it. */
const MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '];

/** A model as Claude Code names it: `claude-opus-5-5` is `Opus 5.5`, and a dated `claude-sonnet-4-20250514` is `Sonnet 4`. */
export function modelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  if (match === null) return model;
  return `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`;
}

export interface WelcomeOptions {
  cwd: string;
  home: string | undefined;
  model: string;
  version: string;
}

/** The box each TUI opens with. */
export function welcome(harness: HarnessName, { cwd, home, model, version }: WelcomeOptions): string[] {
  const where = shownPath(cwd, home);
  if (harness === 'codex') {
    return box([`>_ OpenAI Codex (v${version})`, '', `model:     ${model}   /model to change`, `directory: ${where}`], DIM);
  }
  // Claude Code 2.x's: its version in the top edge, a welcome, the mascot, the model and the folder, centred.
  return box(['', 'Welcome back!', '', ...MASCOT, '', modelName(model), where, ''], CLAUDE_ORANGE, { title: `Claude Code v${version}`, centre: true });
}

/** The user's prompt as it stays on screen once sent. */
export function userPrompt(harness: HarnessName, prompt: string): string[] {
  const [first = '', ...rest] = prompt.split('\n');
  const mark = harness === 'codex' ? '›' : '>';
  return [paint(DIM, `${mark} ${first}`), ...rest.map((line) => paint(DIM, `  ${line}`))];
}

/** One frame of the spinner a TUI shows while the model thinks: the `frame`th. */
export function spinner(harness: HarnessName, frame: number): string {
  if (harness === 'codex') return `${paint(BOLD, frame % 2 === 0 ? '•' : '◦')} Working ${paint(DIM, `(${frame}s • esc to interrupt)`)}`;
  return `${paint(CLAUDE_ORANGE, `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Thinking…`)} ${paint(DIM, '(esc to interrupt)')}`;
}

/**
 * What the model says, its Markdown drawn as the TUIs draw it: a bullet on its first line, the rest indented under it.
 */
export function assistantText(harness: HarnessName, text: string): string[] {
  const [first = '', ...rest] = text.split('\n').map(markdownLine);
  return [`${harness === 'codex' ? '•' : '⏺'} ${first}`, ...rest.map((line) => (line === '' ? '' : `  ${line}`))];
}

/** Each style's on and off codes, so one can sit inside another without ending it. */
const STYLE = { bold: ['1', '22'], strike: ['9', '29'], code: ['38;2;177;185;249', '39'] } as const;
const styled = (style: keyof typeof STYLE, text: string) => `\x1b[${STYLE[style][0]}m${text}\x1b[${STYLE[style][1]}m`;

/** One line of Markdown as a terminal shows it: a heading bold, a list item bulleted, and its code, bold and struck text styled. */
function markdownLine(line: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return styled('bold', inline(heading[1]!));
  const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (item) return `${item[1]}• ${inline(item[2]!)}`;
  return inline(line);
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => styled('code', code))
    .replace(/\*\*(.+?)\*\*/g, (_, bold: string) => styled('bold', bold))
    .replace(/~~(.+?)~~/g, (_, struck: string) => styled('strike', struck));
}

/** A tool's input in one short phrase: its command, its file or its pattern, else its fields. */
function inputSummary(input: Record<string, unknown>, cwd: string): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'description']) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    return key === 'command' ? value : shownFile(value, cwd);
  }
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
}

/** A file as the TUIs name it: relative to where the session runs. */
function shownFile(path: string, cwd: string): string {
  return isAbsolute(path) ? relative(cwd, path) || path : path;
}

/** The heading a tool call shows as it starts. */
export function toolHeading(harness: HarnessName, name: string, input: Record<string, unknown>, cwd: string): string {
  const summary = inputSummary(input, cwd);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (harness === 'codex') {
    if (name === 'Bash') return `${paint(BOLD, '•')} ${paint(BOLD, 'Ran')} ${summary}`;
    if (name === 'update_plan') return `${paint(BOLD, '•')} ${paint(BOLD, 'Updated Plan')}`;
    if (name === 'apply_patch') return `${paint(BOLD, '•')} ${paint(BOLD, 'Edited')} ${summary}`;
    return `${paint(BOLD, '•')} ${paint(BOLD, 'Called')} ${mcp ? `${mcp[1]}.${mcp[2]}` : name}(${summary})`;
  }
  const bullet = paint(GREEN, '⏺');
  if (name === 'TodoWrite') return `${bullet} ${paint(BOLD, 'Update Todos')}`;
  if (name === 'Edit') return `${bullet} ${paint(BOLD, 'Update')}(${summary})`;
  if (mcp) return `${bullet} ${paint(BOLD, `${mcp[1]} - ${mcp[2]} (MCP)`)}(${summary})`;
  return `${bullet} ${paint(BOLD, name)}(${summary})`;
}

/** One item of a todo list, as both harnesses' tools take it. */
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** One hunk of a file's change, as Claude's Edit tool reports it (`structuredPatch`). */
export interface PatchHunk {
  oldStart: number;
  newStart: number;
  /** Each line led by `-`, `+` or a space. */
  lines: string[];
}

/** The lines under a tool call once it has run: its output, folded after a few lines, a todo list or a diff. */
export function toolResult(harness: HarnessName, name: string, input: Record<string, unknown>, response: unknown, cwd: string): string[] {
  const todos = (input.todos ?? input.plan) as (Todo | { step: string; status: Todo['status'] })[] | undefined;
  if (todos !== undefined) return under(harness, todos.map((todo) => todoLine(harness, 'content' in todo ? todo.content : todo.step, todo.status)));
  const patch = (response as { structuredPatch?: PatchHunk[] } | undefined)?.structuredPatch;
  if (patch !== undefined) {
    const added = patch.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith('+')).length;
    const removed = patch.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith('-')).length;
    const file = shownFile(String(input.file_path ?? input.path ?? ''), cwd);
    const said =
      harness === 'codex'
        ? `${paint(GREEN, `+${added}`)} ${paint('31', `-${removed}`)}`
        : `Updated ${paint(BOLD, file)} with ${plural(added, 'addition')} and ${plural(removed, 'removal')}`;
    return under(harness, [said, ...patch.flatMap(diffLines)]);
  }
  if (name === 'Read') return under(harness, [`Read ${paint(BOLD, String(lineCount(toolOutputText(response))))} lines`]);
  if (name === 'Write' || name === 'apply_patch') {
    const content = String(input.content ?? '');
    return under(harness, [`Wrote ${paint(BOLD, String(lineCount(content)))} lines to ${paint(BOLD, shownFile(String(input.file_path ?? input.path ?? ''), cwd))}`]);
  }
  const output = toolOutputText(response).replace(/\n+$/, '');
  if (output === '') return under(harness, [paint(DIM, '(No content)')]);
  const lines = output.split('\n');
  const folded = lines.length > SHOWN_OUTPUT_LINES ? [...lines.slice(0, SHOWN_OUTPUT_LINES), paint(DIM, `… +${lines.length - SHOWN_OUTPUT_LINES} lines`)] : lines;
  return under(harness, folded);
}

/** A tool call the user turned down. */
export function toolDenied(harness: HarnessName): string[] {
  return under(harness, [paint('31', 'User rejected the tool call')]);
}

/** `lines` hung under a tool call's heading. */
function under(harness: HarnessName, lines: string[]): string[] {
  const hook = harness === 'codex' ? '  └ ' : '  ⎿  ';
  const indent = ' '.repeat(harness === 'codex' ? 4 : 5);
  return lines.map((line, at) => (at === 0 ? hook : indent) + line);
}

function todoLine(harness: HarnessName, text: string, status: Todo['status']): string {
  if (status === 'completed') return paint(DIM, `${harness === 'codex' ? '✔' : '☒'} ${paint('9', text)}`);
  const box = harness === 'codex' ? '□' : '☐';
  return status === 'in_progress' ? paint(BOLD, `${box} ${text}`) : `${box} ${text}`;
}

/** A hunk's lines, numbered, the removed ones red and the added ones green. */
function diffLines(hunk: PatchHunk): string[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    const [mark, text] = [line[0], line.slice(1)];
    if (mark === '-') return paint(DIFF_REMOVED, `${String(oldLine++).padStart(4)} - ${text}`);
    if (mark === '+') return paint(DIFF_ADDED, `${String(newLine++).padStart(4)} + ${text}`);
    oldLine++;
    return `${String(newLine++).padStart(4)}   ${text}`;
  });
}

/** The box a TUI asks permission in, with the answers it takes. */
export function permissionPrompt(harness: HarnessName, input: Record<string, unknown>, cwd: string): string[] {
  const command = inputSummary(input, cwd);
  const description = typeof input.description === 'string' ? input.description : undefined;
  if (harness === 'codex') {
    return box(['Allow command?', '', `$ ${command}`, '', '› 1. Yes, proceed', '  2. No, and tell Codex what to do differently'], DIM);
  }
  return box(
    [
      'Bash command',
      '',
      `  ${command}`,
      ...(description === undefined ? [] : [`  ${description}`]),
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again for this command",
      '  3. No, and tell Claude what to do differently (esc)',
    ],
    CLAUDE_ORANGE,
  );
}

/** Whether an answer typed at a demo permission prompt allows the call: a row of its box that says yes, or y. */
export function allowsInDemo(harness: HarnessName, answer: string): boolean {
  const yes = harness === 'codex' ? /^(1|y(es)?)$/i : /^(1|2|y(es)?)$/i;
  return yes.test(answer.trim());
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
}

/** A tool's output as text: an MCP result's text parts, else as `toolOutput` reads it. */
function toolOutputText(response: unknown): string {
  const content = (response as { content?: { text?: string }[] } | undefined)?.content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('\n');
  return toolOutput(response);
}
