import { isObject } from './json.ts';
import type { ChatEntry, Harness } from './protocol.ts';

/**
 * Versioned adapters from each harness's transcript to chat entries (ADR-0004). Both formats are internal to
 * their harness and change without notice, so each adapter names the versions it was built against: a transcript
 * from any other version, or a line that isn't one of its entries at all, makes the whole transcript unsupported and
 * the session window shows only the terminal. Entry types an adapter doesn't know inside a version it does are
 * skipped: real transcripts are mostly bookkeeping (attachments, queue operations, titles, token counts), and new
 * kinds come with every release. One attachment is a message: Claude writes one the user sent mid-turn as a
 * `queued_command`, where it took it. The entries the chat is made of must match, though: a Claude `user` or `assistant`
 * entry without its `version` or its `message` object means the format changed, so it is unsupported too, as is any
 * entry, anywhere in the file, from a version the adapter doesn't know (a session resumed under a newer release).
 *
 * - Claude Code 2.x: `~/.claude/projects/<project>/<session-id>.jsonl`, one entry per line with a string `type` and
 *   the Claude Code `version` that wrote it. Built against 2.1.296 (`fixtures/claude/`).
 * - Codex 0.x: `$CODEX_HOME/sessions/…/rollout-…-<session-id>.jsonl`, `{timestamp, type, payload}` per line, opening
 *   with `session_meta` and its `cli_version`. Built against 0.162.0-alpha.2 (`fixtures/codex/rollouts/`).
 */
export interface TranscriptParser {
  /** The entries one line of the transcript adds: none once it is unsupported. */
  push(line: string): ChatEntry[];
  /** Why the transcript can't be read, once it can't. */
  readonly unsupported: string | undefined;
}

export interface TranscriptParserOptions {
  /** A Claude subagent's own transcript, whose entries are all on its sidechain. */
  subagent?: boolean;
}

/** The longest text an entry keeps: a tool's output can run to megabytes. */
const MAX_ENTRY_TEXT = 4000;

const SUPPORTED_CLAUDE_MAJOR = 2;
const SUPPORTED_CODEX_MAJOR = 0;

/** Messages Claude Code puts in the user's turn for itself or a slash command, which its TUI doesn't show as typed. */
const CLAUDE_HIDDEN_USER_TEXT = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|system-reminder|task-notification|user-prompt-submit-hook)>/;

/** A background task's report, which Claude gives the model as a prompt of its own. */
const CLAUDE_TASK_NOTIFICATION = /^<task-notification>/;

/** Claude's interrupt, `for tool use` when the user turned down or stopped the call just before it. */
const CLAUDE_INTERRUPTED = /^\[Request interrupted by user( for tool use)?[^\]]*\]$/;

/** How Codex's `exec` tool reports a script that failed, or a call the user stopped. */
const CODEX_FAILED = /^(?:Script failed|aborted\b)|\bexit_code=(?!0\b)-?\d+/;

const UNRECOGNISED = 'the transcript has an entry it does not recognise';

type Json = Record<string, unknown>;

/** A transcript line's adapter result: entries, or why the transcript can't be read. */
type LineResult = ChatEntry[] | { unsupported: string };

export function createTranscriptParser(harness: Harness, options: TranscriptParserOptions = {}): TranscriptParser {
  let unsupported: string | undefined;
  /**
   * The latest time an earlier line of the conversation was written, whether or not it made an entry. The latest, as
   * Claude stamps a message queued during a turn with when it was queued, before the lines it lands among.
   */
  let previousAt: string | undefined;
  const ofConversation = harness === 'claude' ? claudeOfConversation : () => true;
  const adapter = harness === 'claude' ? claudeAdapter(options.subagent === true) : codexAdapter();
  return {
    push(line) {
      if (unsupported !== undefined || line.trim() === '') return [];
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        unsupported = 'the transcript has a line that is not JSON';
        return [];
      }
      const result = isObject(entry) ? adapter(entry) : { unsupported: UNRECOGNISED };
      if (!Array.isArray(result)) {
        unsupported = result.unsupported;
        return [];
      }
      const timestamp = isObject(entry) && typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
      const entries = stamped(result, timestamp, previousAt);
      const later = timestamp !== undefined && (previousAt === undefined || Date.parse(timestamp) > Date.parse(previousAt));
      if (later && isObject(entry) && ofConversation(entry)) previousAt = timestamp;
      return entries;
    },
    get unsupported() {
      return unsupported;
    },
  };
}

/**
 * The entries with the time their line was written, when it has one: both harnesses put a `timestamp` on each line.
 * Thinking also gets the latest time a line before it was written, any line, as the lines that start a turn aren't
 * all entries.
 */
function stamped(entries: ChatEntry[], timestamp: string | undefined, previousAt: string | undefined): ChatEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(timestamp === undefined ? {} : { at: timestamp }),
    ...(entry.kind === 'thinking' && previousAt !== undefined ? { since: previousAt } : {}),
  }));
}

/**
 * Whether a Claude line is of the conversation, so thinking after it is timed from it: a prompt, a reply, a tool's
 * result, a turn's bookkeeping or a message queued during it. Not Claude's other attachments and records
 * (`deferred_tools_record`, queue operations, file history), which it writes within a millisecond of the thinking,
 * either side of it.
 */
function claudeOfConversation(entry: Json): boolean {
  if (entry.type === 'attachment') return isObject(entry.attachment) && entry.attachment.type === 'queued_command';
  return entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system';
}

function claudeAdapter(subagent: boolean): (entry: Json) => LineResult {
  return (entry) => {
    if (typeof entry.type !== 'string') return { unsupported: UNRECOGNISED };
    if (typeof entry.version === 'string' && majorOf(entry.version) !== SUPPORTED_CLAUDE_MAJOR) {
      return { unsupported: `Claude Code ${entry.version} transcripts are not supported yet` };
    }
    if (entry.type === 'attachment') return entry.isSidechain === true && !subagent ? [] : claudeQueued(entry.attachment);
    if (entry.type === 'system') return entry.isSidechain === true && !subagent ? [] : claudeSystem(entry);
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    if (typeof entry.version !== 'string') return { unsupported: 'a message entry has no Claude Code version' };
    if (!isObject(entry.message)) return { unsupported: 'a message entry has no message object' };
    if (entry.isSidechain === true && !subagent) return [];
    const { content } = entry.message;
    if (entry.type === 'assistant') return claudeAssistant(content);
    return entry.isMeta === true || entry.isCompactSummary === true ? [] : claudeUser(entry, content);
  };
}

/** Where Claude compacted the conversation (its summary, the next `user` entry, is left out), and how long a turn took. */
function claudeSystem(entry: Json): ChatEntry[] {
  if (entry.subtype === 'compact_boundary') return [{ kind: 'compacted' }];
  if (entry.subtype === 'turn_duration' && typeof entry.durationMs === 'number' && entry.durationMs >= 0) return [{ kind: 'turn-ended', ms: entry.durationMs }];
  return [];
}

function claudeUser(entry: Json, content: unknown): ChatEntry[] {
  if (typeof content === 'string') return userText(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ChatEntry[] => {
    if (!isObject(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string') return userText(block.text);
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return [];
    const agentId = isObject(entry.toolUseResult) && typeof entry.toolUseResult.agentId === 'string' ? entry.toolUseResult.agentId : undefined;
    return [
      {
        kind: 'tool-result',
        id: block.tool_use_id,
        output: clip(blockText(block.content)),
        isError: block.is_error === true,
        ...(agentId === undefined ? {} : { agentId }),
      },
    ];
  });
}

/**
 * A message that came in while a turn ran, where Claude took it, at a step of that turn: Claude writes it as a
 * `queued_command` attachment, not a `user` entry. One the user sent is a `prompt` (the mode may be left out); a
 * subagent's report (`isMeta`) is Claude's bookkeeping, as a `user` entry marked so is, and a background task's
 * notification (`task-notification`) is `notified`, as its text is. Any other attachment is bookkeeping.
 */
function claudeQueued(attachment: unknown): ChatEntry[] {
  if (!isObject(attachment) || attachment.type !== 'queued_command' || attachment.isMeta === true) return [];
  if ((attachment.commandMode ?? 'prompt') !== 'prompt' || typeof attachment.prompt !== 'string') return [];
  return userText(attachment.prompt);
}

function userText(text: string): ChatEntry[] {
  const interrupted = CLAUDE_INTERRUPTED.exec(text.trim());
  if (interrupted) return [{ kind: 'notice', text: 'Interrupted', ...(interrupted[1] === undefined ? {} : { forToolUse: true as const }) }];
  if (CLAUDE_TASK_NOTIFICATION.test(text.trimStart())) return [{ kind: 'notified' }];
  if (CLAUDE_HIDDEN_USER_TEXT.test(text.trimStart()) || text.trim() === '') return [];
  return [{ kind: 'user', text }];
}

function claudeAssistant(content: unknown): ChatEntry[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ChatEntry[] => {
    if (!isObject(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return [{ kind: 'assistant', text: block.text }];
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      return [{ kind: 'tool-call', id: block.id, name: block.name, input: clipInput(block.input) }];
    }
    // Claude writes most thinking with its text left out (and redacted thinking with none at all).
    if (block.type === 'thinking') return [{ kind: 'thinking', text: typeof block.thinking === 'string' ? clip(block.thinking.trim()) : '' }];
    if (block.type === 'redacted_thinking') return [{ kind: 'thinking', text: '' }];
    // The server's own tools aren't in the TUI's transcript either.
    return [];
  });
}

function codexAdapter(): (entry: Json) => LineResult {
  let started = false;
  return (entry) => {
    if (typeof entry.type !== 'string' || !isObject(entry.payload)) return { unsupported: UNRECOGNISED };
    const payload = entry.payload;
    if (!started) {
      if (entry.type !== 'session_meta') return { unsupported: 'the rollout does not start with its session line' };
      const version = typeof payload.cli_version === 'string' ? payload.cli_version : 'unknown';
      if (majorOf(version) !== SUPPORTED_CODEX_MAJOR) return { unsupported: `Codex ${version} rollouts are not supported yet` };
      started = true;
      return [];
    }
    // `response_item`s are the record; `event_msg`s mostly repeat them for the TUI.
    if (entry.type === 'event_msg') return payload.type === 'turn_aborted' ? [{ kind: 'notice', text: 'Interrupted' }] : [];
    if (entry.type === 'compacted') return [{ kind: 'compacted' }];
    if (entry.type !== 'response_item') return [];
    switch (payload.type) {
      case 'message':
        return codexMessage(payload);
      // Its summary, when Codex wrote one; the reasoning itself is encrypted.
      case 'reasoning':
        return [{ kind: 'thinking', text: clip(blockText(payload.summary).trim()) }];
      case 'function_call':
      case 'custom_tool_call': {
        if (typeof payload.call_id !== 'string' || typeof payload.name !== 'string') return [];
        const input = payload.type === 'function_call' ? parseArguments(payload.arguments) : payload.input;
        return [{ kind: 'tool-call', id: payload.call_id, name: payload.name, input: clipInput(input) }];
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        if (typeof payload.call_id !== 'string') return [];
        const output = blockText(payload.output);
        return [{ kind: 'tool-result', id: payload.call_id, output: clip(output), isError: codexFailed(output) }];
      }
      case 'agent_message':
        return [
          {
            kind: 'subagent-message',
            from: typeof payload.author === 'string' ? payload.author : '',
            to: typeof payload.recipient === 'string' ? payload.recipient : '',
            text: clip(agentMessagePayload(blockText(payload.content))),
          },
        ];
      default:
        return [];
    }
  };
}

function codexMessage(payload: Json): ChatEntry[] {
  const text = blockText(payload.content);
  if (text.trim() === '') return [];
  if (payload.role === 'assistant') return [{ kind: 'assistant', text }];
  if (payload.role !== 'user') return [];
  // Codex tags what it put in the user's turn itself (its environment context); a rollout without tags shows them all.
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const kinds = isObject(metadata) && Array.isArray(metadata.content_item_kinds) ? metadata.content_item_kinds : undefined;
  if (kinds ? !kinds.includes('user.text') : text.startsWith('<environment_context>')) return [];
  return [{ kind: 'user', text }];
}

/**
 * Whether a Codex call's output says it failed: its `exec` script failed, or the user stopped it, or its command's
 * `exit_code` (in the script's text, or the metadata of an older `shell` call's JSON) wasn't 0.
 */
function codexFailed(output: string): boolean {
  if (CODEX_FAILED.test(output)) return true;
  const parsed = parseArguments(output);
  const exitCode = isObject(parsed) && isObject(parsed.metadata) ? parsed.metadata.exit_code : undefined;
  return typeof exitCode === 'number' && exitCode !== 0;
}

/** What an inter-agent message carries, after its `Payload:` header. */
function agentMessagePayload(text: string): string {
  const at = text.indexOf('Payload:\n');
  return (at < 0 ? text : text.slice(at + 'Payload:\n'.length)).trim();
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The text of a string, or of a list of text blocks (`text`, `input_text`, `output_text`), joined by line breaks. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (!isObject(block)) return [];
      if (typeof block.text === 'string') return [block.text];
      return block.type === 'image' ? ['[image]'] : [];
    })
    .join('\n');
}

function clip(text: string): string {
  return text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT)}…` : text;
}

/**
 * A call's input, small enough to keep: every long string in it clipped (e.g. the whole file a Write call writes), and
 * one with many of them shown as clipped JSON text instead.
 */
function clipInput(value: unknown): unknown {
  const clipped = clipStrings(value);
  const text = JSON.stringify(clipped) ?? '';
  return text.length > 2 * MAX_ENTRY_TEXT ? clip(JSON.stringify(clipped, null, 2)) : clipped;
}

/** The value with every long string in it clipped. */
function clipStrings(value: unknown): unknown {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return value.map(clipStrings);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clipStrings(inner)]));
  return value;
}

function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : undefined;
}
