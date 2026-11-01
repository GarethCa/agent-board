// How a permission prompt reads under the Simplified design: one plain sentence per tool from a fixed table, the raw tool
// and input for any other, and whether it asks for something the pane never allows inline.

/** What a permission prompt carries of the call, whatever shows it. */
export interface PromptCall {
  toolName: string;
  toolInput: unknown;
}

export interface PermissionSentence {
  /** What the call does, in a plain sentence: "Run a command", "Change a file". */
  sentence: string;
  /** What it does it to: the command, the path, the address; the raw input for a tool without a sentence. */
  detail: string;
  /** Whether the tool is in the table; the others read as "Use <tool>" with their raw input. */
  known: boolean;
  /** Whether it can destroy work that can't be got back, so the pane offers Review… and no inline Allow. */
  destructive: boolean;
}

/** The one-line sentence for each tool the table covers, and where in its input the thing it acts on is. */
const TOOLS: Record<string, { sentence: string; field: string }> = {
  Bash: { sentence: 'Run a command', field: 'command' },
  Edit: { sentence: 'Change a file', field: 'file_path' },
  MultiEdit: { sentence: 'Change a file', field: 'file_path' },
  NotebookEdit: { sentence: 'Change a notebook', field: 'notebook_path' },
  Write: { sentence: 'Write a file', field: 'file_path' },
  WebFetch: { sentence: 'Read a web page', field: 'url' },
};

const field = (input: unknown, name: string): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** The prompt as a sentence and the thing it acts on. A tool outside the table, or a call without its field, reads raw. */
export function permissionSentence(call: PromptCall): PermissionSentence {
  const tool = TOOLS[call.toolName];
  const detail = tool === undefined ? undefined : field(call.toolInput, tool.field);
  if (tool === undefined || detail === undefined) {
    const raw = call.toolInput === null || call.toolInput === undefined ? '' : JSON.stringify(call.toolInput);
    return { sentence: `Use ${call.toolName}`, detail: raw, known: false, destructive: false };
  }
  const why = call.toolName === 'Bash' ? field(call.toolInput, 'description') : undefined;
  return {
    sentence: why === undefined ? tool.sentence : `${tool.sentence}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
    detail,
    known: true,
    destructive: call.toolName === 'Bash' && isDestructiveCommand(detail),
  };
}

// What counts as destructive. The rule: the command deletes, overwrites or rewrites something a person can't get back
// from the repo (files outside git's reach, history, a database, a process, a disk) or runs code it has just fetched.
// It errs towards Review…: a command wrongly listed costs the user one look at the terminal, one wrongly left off lets
// a click lose work. Shell words are matched outside quotes, so `grep "rm -rf"` is not `rm -rf`; SQL is matched anywhere.

/** Shell commands that remove or overwrite whatever they name, wherever they stand, after `sudo`, a path or a backslash. */
const DESTRUCTIVE_WORDS = /(?:^|[\s;&|(`])\\?(?:\S*\/)?(?:rm|rmdir|unlink|shred|truncate|dd|killall|pkill|kill|mkfs(?:\.\w+)?|srm|rimraf)(?=$|[\s;&|)`])/;

/** Multi-word commands, each as a pattern over the command with quoted text blanked. */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\bgit\s+(?:\S+\s+)*push\b(?=[^;&|]*(?:\s--force\b|\s--force-with-lease\b|\s-\w*f\w*(?=\s|$)|\s\+\S|\s--delete\b|\s-d\b|\s:\S))/,
  /\bmv\b[^;&|]*\s\/dev\/null\b/,
  /\brsync\b[^;&|]*\s--(?:delete|del|remove-source-files)\b/,
  /\bgit\s+reset\b[^;&|]*--(?:hard|merge)\b/,
  /\bgit\s+clean\b[^;&|]*-\w*[fd]/,
  /\bgit\s+checkout\b[^;&|]*(?:\s--\s+\S|\s-f\b|\s--force\b|\s\.(?:\s|$))/,
  /\bgit\s+switch\b[^;&|]*\s(?:-f\b|--force\b|--discard-changes\b)/,
  /\bgit\s+restore\b/,
  /\bgit\s+branch\b[^;&|]*\s(?:-D\b|--delete\b[^;&|]*\s(?:--force|-f)\b|(?:--force|-f)\b[^;&|]*\s--delete\b)/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  /\bgit\s+worktree\s+(?:remove|prune)\b/,
  /\bgit\s+filter-(?:branch|repo)\b/,
  /\bgit\s+update-ref\s+-d\b/,
  /\bfind\b[^;&|]*(?:\s-delete\b|\s-exec\s+(?:\S*\/)?rm\b)/,
  /\b(?:chmod|chown|chgrp)\s+(?:\S+\s+)*-\w*R/,
  /\b(?:brew|npm|pnpm|yarn|pip|pip3|cargo|apt|apt-get)\s+(?:uninstall|remove|rm)\b/,
  /\bdocker\s+(?:system\s+prune|(?:container\s+|image\s+|volume\s+)?(?:rm|rmi|prune)|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,
  // Runs what it fetched: into a shell from anywhere, into another interpreter from curl or wget, or as a shell's script.
  /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
  /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|php)\b/,
];

/** A shell, `eval` or `source` given what `curl` or `wget` fetches by substitution: it runs what it fetched. */
const FETCHED_SCRIPT = /\b(?:(?:ba|z|da)?sh|eval|source|python3?|node|perl|ruby|php)\b[^;&|]*(?:\$\(|<\()\s*(?:curl|wget)\b/;

/** SQL that drops or empties data, matched in the raw command: it sits inside a client's quotes. */
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:table|database|schema|index|view)|truncate\s+(?:table\s+)?\w+|delete\s+from)\b/i;

/** `>` or `>|` that writes (not `>>`, `>&` or a write to /dev/null) truncates its target. */
const TRUNCATING_REDIRECT = /(?:^|[^>&\d])\d?>\|?\s*(?!\s*\/dev\/null\b)(?=[^\s>&])/;

/** `command` with whatever is in single or double quotes blanked, so a word in a string is not a command. */
const unquoted = (command: string): string => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

/**
 * The text a command runs as a command of its own: what `sh -c`, `eval` and `ssh host` are given in quotes, and what a
 * command substitution `$(…)`, process substitution `<(…)` or backticks holds. Quoted text elsewhere is only text.
 */
const RUNNERS: readonly RegExp[] = [
  /\b(?:(?:ba|z|da|k|a)?sh|eval)\b(?:\s+--?[\w-]+)*\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g,
  /\bssh\b[^;&|]*?\s(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g,
  /\$\(([^)]*)\)/g,
  /<\(([^)]*)\)/g,
  /`([^`]*)`/g,
];

const nested = (command: string): string[] => RUNNERS.flatMap((runner) => [...command.matchAll(runner)].map((match) => match.slice(1).find((group) => group !== undefined) ?? ''));

/**
 * Whether a shell command is one the pane never allows inline (see the rule above): the command itself, or any command
 * it runs from quoted text (`bash -c "rm -rf ~"`, `ssh host "…"`, `$(…)`), to any depth.
 */
export function isDestructiveCommand(command: string, depth = 0): boolean {
  if (DESTRUCTIVE_SQL.test(command)) return true;
  const bare = unquoted(command);
  if (DESTRUCTIVE_WORDS.test(bare) || DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(bare)) || TRUNCATING_REDIRECT.test(bare)) return true;
  // A shell given a fetched script in quotes (`sh -c "$(curl …)"`) is the one pattern that needs them.
  if (FETCHED_SCRIPT.test(command)) return true;
  return depth < 4 && nested(command).some((inner) => inner !== command && isDestructiveCommand(inner, depth + 1));
}
