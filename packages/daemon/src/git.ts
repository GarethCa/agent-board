import { execFile } from 'node:child_process';
import { constants, existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Git's exit code, from `runGit`: null when it was killed, or its output overran `RunGitOptions.maxBuffer`. */
  exitCode?: number | null;
}

export interface RunGitOptions {
  /**
   * Runs the repo's hooks, which `runGit` otherwise turns off. Only for a command whose hook the user wants run by the
   * board: a hook can be a file an agent wrote (an in-tree `core.hooksPath`, as husky sets), and the daemon would run it
   * outside the agent's permissions.
   */
  hooks?: true;
  /**
   * Turns off every filter the repo's own config names (`repoFiltersOffEnv`), for a read whose clean filter would run as
   * the daemon: a status or diff of files changed in a worktree, or hashing them.
   */
  repoFiltersOff?: true;
  /** The most output, in bytes, to take: past it, git is killed and fails. Node's own limit (1 MiB) otherwise. */
  maxBuffer?: number;
}

/** Turns the repo's hooks off for one git command: `git -c core.hooksPath=/dev/null …` finds no hook to run. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const;

/**
 * Always on: no fsmonitor, a program named in the repo's config that git would run on every `status`, and that an agent
 * could point at a script of its own. The daemon's reads of a worktree's status don't need it.
 */
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'] as const;

/**
 * Runs `git -C <dir> <args>`. Resolves whether or not git succeeds; rejects only when git itself can't be run. Any
 * GIT_DIR/GIT_WORK_TREE the daemon inherited are ignored: `dir` alone decides the repo. With `timeoutMs`, git is killed
 * after that long, which counts as a failure. Optional locks are off (`GIT_OPTIONAL_LOCKS=0`): a read like `status` never
 * refreshes and writes the index, so it can't hold `index.lock` against the user's own git. `env` adds to its
 * environment: `{ LC_ALL: 'C' }` for a message to be read, which a translated git would otherwise word in its language.
 *
 * Hooks are off (see `RunGitOptions.hooks`), and so is any fsmonitor: the folders the daemon runs git in are agents'
 * worktrees and the repos they share, where a hook, or the program a config names, may be agent-written. Filters still
 * run (the user's own, and Git LFS's), so Git LFS still smudges its files at checkout; what its hooks did is either not needed by the daemon (marking
 * locked files read-only) or done explicitly (`pushLfsObjects`). A push goes through `pushBranch`, and a fetch checks
 * `checkRepoConfig` first; a checkout or merge checks `checkCheckoutConfig`, and each runs with the pins the check gives
 * (`CheckedConfig`); a read that would run a clean filter turns the repo's own filters off (`RunGitOptions.repoFiltersOff`).
 */
export async function runGit(dir: string, args: string[], timeoutMs?: number, extraEnv: Record<string, string> = {}, options: RunGitOptions = {}): Promise<GitResult> {
  const given = { ...process.env, ...extraEnv };
  const env = { ...given, ...(options.repoFiltersOff === true ? await repoFiltersOffEnv(dir, given) : {}) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_OPTIONAL_LOCKS = '0';
  const hooks = options.hooks === true ? [] : NO_HOOKS;
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...NO_FSMONITOR, ...hooks, ...args], { env, timeout: timeoutMs, maxBuffer: options.maxBuffer }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') reject(new Error('git was not found on PATH'));
      else resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: error === null ? 0 : typeof code === 'number' && !error.killed ? code : null });
    });
  });
}

/**
 * The keys of the repo's own config that name a program git runs as it pushes or fetches: ssh (`core.sshCommand`,
 * `core.gitProxy`), a password prompt (`core.askPass`), a credential helper (`credential.helper`,
 * `credential.<url>.helper`), the command a fetch runs to list an alternate's refs (`core.alternateRefsCommand`), the
 * program a remote runs at the other end, which for a remote that is a local folder runs here
 * (`remote.<name>.uploadpack`, `remote.<name>.receivepack`), the protocols git may use (`protocol.allow`,
 * `protocol.<name>.allow`), as allowing `ext::` lets a remote's URL be any command, and a Git LFS transfer agent
 * (`lfs.customtransfer.<name>.path`, `lfs.standalonetransferagent` and `lfs.<url>.standalonetransferagent`), which `git lfs push` runs. Signing isn't here:
 * the board's pushes never sign (`--no-signed`), so a repo may keep its own `gpg.*` settings for its commits.
 */
const REPO_PROGRAM_KEY =
  /^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|credential\.(.+\.)?helper|remote\..+\.(uploadpack|receivepack)|protocol\.(.+\.)?allow|lfs\.customtransfer\..+\.path|lfs\.(.+\.)?standalonetransferagent)$/i;

/** The config scopes an agent can write from its worktree: the repo's `.git/config` and a worktree's own file. */
const REPO_SCOPES = new Set(['local', 'worktree']);

/** The config scopes that are the user's own: what an agent can't write from its worktree. */
const USER_SCOPES = new Set(['global', 'system']);

/** One entry of a repo's config: its scope, its name, and its value. */
interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** Every entry of the config git reads in `dir`, each with its scope; git's words when it can't read it. */
async function configEntries(dir: string): Promise<{ entries: ConfigEntry[] } | { error: string }> {
  const listed = await runGit(dir, ['config', '--show-scope', '--list', '-z']);
  if (!listed.ok) return { error: listed.stderr };
  // With -z, each entry is its scope, then its name and value (a newline between), each ended by a NUL.
  const fields = listed.stdout.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const entry = fields[i + 1] ?? '';
    const newline = entry.indexOf('\n');
    const [key, value] = newline === -1 ? [entry, ''] : [entry.slice(0, newline), entry.slice(newline + 1)];
    entries.push({ scope, key, value });
  }
  return { entries };
}

/** A setting for one git command, as `-c` would give it: its key and its value. */
type Setting = readonly [key: string, value: string];

/**
 * `settings` for one git command, through `GIT_CONFIG_COUNT` (after any in `given`, the environment the command runs
 * with), not `-c`, as a name may hold an `=`. Settings given this way win over every config file.
 */
function configCountEnv(settings: readonly Setting[], given: NodeJS.ProcessEnv): Record<string, string> {
  if (settings.length === 0) return {};
  const inherited = Number(given.GIT_CONFIG_COUNT ?? '0');
  const from = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(from + settings.length) };
  settings.forEach(([key, value], at) => {
    env[`GIT_CONFIG_KEY_${from + at}`] = key;
    env[`GIT_CONFIG_VALUE_${from + at}`] = value;
  });
  return env;
}

/** The last value `key` (as `git config --list` names it) has in `entries`, or undefined. */
function lastValue(entries: readonly ConfigEntry[], key: string): string | undefined {
  return entries.findLast((entry) => entry.key === key)?.value;
}

/** The entries an agent can't write from its worktree: the user's global and system config, and the command line's. */
const trustedEntries = (entries: readonly ConfigEntry[]) => entries.filter((entry) => !REPO_SCOPES.has(entry.scope));

/**
 * A guarded git command's config, as the board checked it. Git reads the config again as the command runs, and an agent
 * could write a key into the repo's in between. So the command runs with `env` and `args`, which pin each program
 * the check guards to what the checked config gives it: what the command line sets wins over any config file. `after`
 * reads the config again once the command has run, for the keys no pin holds, and says why if one is set now.
 */
export interface CheckedConfig {
  /** For the command's environment (`runGit`'s `extraEnv`). */
  env: Record<string, string>;
  /** For a push's or fetch's command line, before the remote: the `--receive-pack` or `--upload-pack` it would use. */
  args: string[];
  /** Why, once the command has run, the repo's own config names a program no pin held; undefined when it doesn't. */
  after(): Promise<string | undefined>;
}

/** A guarded command's config: refused, saying why, or checked. */
export type ConfigCheck = { refused: string } | CheckedConfig;

/** What a guarded command runs with (`CheckedConfig`), and which refused keys that holds whatever the repo's config says. */
interface Pins {
  settings: Setting[];
  env: Record<string, string>;
  args: string[];
  holds: (key: string) => boolean;
}

/** The repo's own keys (local or worktree, or a file they include) that `refused` says name a program. */
function refusedKeys(entries: ConfigEntry[], refused: (entries: ConfigEntry[]) => (entry: ConfigEntry) => boolean): string[] {
  const refuses = refused(entries);
  return [...new Set(entries.filter((entry) => REPO_SCOPES.has(entry.scope) && refuses(entry)).map((entry) => entry.key))];
}

/**
 * Checks the config git reads in `dir` before the board goes to `doing`: refused when the repo's own config (local or
 * worktree, or a file they include) sets a key `refused` says names a program, given every entry of the config;
 * `because` adds why, for the keys found. A config that can't be read could set anything, so it is refused too.
 * Otherwise checked, with `pins` from the entries read.
 */
async function checkConfig(
  dir: string,
  doing: string,
  refused: (entries: ConfigEntry[]) => (entry: ConfigEntry) => boolean,
  because: (keys: string[]) => string,
  pins: (entries: ConfigEntry[]) => Pins | Promise<Pins | { refused: string }>,
  given: NodeJS.ProcessEnv,
): Promise<ConfigCheck> {
  const listed = await configEntries(dir);
  if ('error' in listed) return { refused: `could not read the repo's config, so the board won't ${doing}: ${listed.error}` };
  const keys = refusedKeys(listed.entries, refused);
  if (keys.length > 0) {
    const refusal = `the repo's own config sets ${keys.join(', ')}, which names a program git would run${because(keys)}; the board won't ${doing} with it. Move it to your global ~/.gitconfig, or ${doing} yourself.`;
    return { refused: refusal };
  }
  const pinned = await pins(listed.entries);
  if ('refused' in pinned) return { refused: `the board won't ${doing}: ${pinned.refused}` };
  return {
    env: { ...pinned.env, ...configCountEnv(pinned.settings, given) },
    args: pinned.args,
    async after() {
      const again = await configEntries(dir);
      if ('error' in again) return `could not read the repo's config again once the board went to ${doing}, so a program it names may have run: ${again.error}`;
      const changed = refusedKeys(again.entries, refused).filter((key) => !pinned.holds(key));
      if (changed.length === 0) return undefined;
      return `the repo's own config came to set ${changed.join(', ')} as the board went to ${doing}, after its check, which names a program git may have run. Find what wrote it; a key of your own goes in your global ~/.gitconfig.`;
    },
  };
}

/** The credential helper keys: `credential.helper` and `credential.<url>.helper`. */
const CREDENTIAL_HELPER_KEY = /^credential\.(.+\.)?helper$/i;

/** Git LFS's keys among `REPO_PROGRAM_KEY`: its transfer agents, which Git LFS reads itself, picking them at run time. */
const LFS_PROGRAM_KEY = /^lfs\./i;

/** A word for a shell, as it is. */
const shellWord = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The pins for the programs a push or fetch runs that the repo's config could name (`REPO_PROGRAM_KEY`), each set to
 * what the trusted config (`trustedEntries`) gives:
 * - credential helpers: the list emptied (as an empty `credential.helper` does), then the trusted ones again, in order;
 * - ssh: `core.sshCommand` as the trusted config has it, else `GIT_SSH`, else `ssh`; none with `GIT_SSH_COMMAND`
 *   set, which git takes before any config;
 * - the password prompt: `core.askPass` as the trusted config has it, else `GIT_ASKPASS` (`SSH_ASKPASS`, or empty,
 *   which asks with no program), which git takes before any config;
 * - the git:// proxy: `GIT_PROXY_COMMAND` empty, which runs none, when no trusted config names one. Git takes the first
 *   `core.gitProxy` that matches, so the user's own come before the repo's, but one for a single host leaves others open;
 * - `core.alternateRefsCommand`: the trusted one, else `true`, which lists no refs (a fetch in a repo with alternates
 *   then offers fewer of the commits it has);
 * - `protocol.ext.allow`, the one protocol whose URL is a command: as the trusted config allows it, else never. Another
 *   protocol a repo allows runs a remote helper on the user's PATH;
 * - `remote.<name>.uploadpack` or `receivepack` (`pack`), of which git takes the first: on the command line instead.
 * Not held: Git LFS's transfer agents (`LFS_PROGRAM_KEY`), and a proxy when the user's own config names one.
 */
function programPins(entries: ConfigEntry[], given: NodeJS.ProcessEnv, remote?: { name: string; pack: 'uploadpack' | 'receivepack' }): Pins {
  const trusted = trustedEntries(entries);
  const settings: Setting[] = [['credential.helper', ''], ...trusted.filter(({ key }) => CREDENTIAL_HELPER_KEY.test(key)).map(({ key, value }): Setting => [key, value])];
  const env: Record<string, string> = {};
  if (given.GIT_SSH_COMMAND === undefined) {
    const ssh = given.GIT_SSH === undefined || given.GIT_SSH === '' ? 'ssh' : shellWord(given.GIT_SSH);
    settings.push(['core.sshCommand', lastValue(trusted, 'core.sshcommand') ?? ssh]);
  }
  if (given.GIT_ASKPASS === undefined) {
    const askPass = lastValue(trusted, 'core.askpass');
    if (askPass !== undefined) settings.push(['core.askPass', askPass]);
    else env.GIT_ASKPASS = given.SSH_ASKPASS ?? '';
  }
  const proxyHeld = given.GIT_PROXY_COMMAND !== undefined || lastValue(trusted, 'core.gitproxy') === undefined;
  if (given.GIT_PROXY_COMMAND === undefined && proxyHeld) env.GIT_PROXY_COMMAND = '';
  settings.push(['core.alternateRefsCommand', lastValue(trusted, 'core.alternaterefscommand') ?? 'true']);
  settings.push(['protocol.ext.allow', lastValue(trusted, 'protocol.ext.allow') ?? lastValue(trusted, 'protocol.allow') ?? 'never']);
  const args: string[] = [];
  if (remote !== undefined) {
    const program = trusted.find(({ key }) => key === `remote.${remote.name}.${remote.pack}`)?.value ?? `git-${remote.pack.replace('pack', '-pack')}`;
    args.push(`--${remote.pack.replace('pack', '-pack')}=${program}`);
  }
  const holds = (key: string) => !LFS_PROGRAM_KEY.test(key) && (key.toLowerCase() !== 'core.gitproxy' || proxyHeld);
  return { settings, env, args, holds };
}

/**
 * Checks the config git reads in `dir` before the board goes to `doing` (`'push'` or `'fetch'`) with `remote`:
 * refused when the repo's own config sets a key that names a program git would run (`REPO_PROGRAM_KEY`). A worktree
 * shares its repo's config, so an agent could point one at a script of its own, which the daemon would then run outside
 * the agent's permissions. The user's global and system config stay trusted, so a `core.sshCommand` in `~/.gitconfig`
 * still works. An included file counts as the scope that includes it. Checked, the command runs with `programPins`.
 */
export function checkRepoConfig(dir: string, doing: 'push' | 'fetch', remote: string, given: NodeJS.ProcessEnv = process.env): Promise<ConfigCheck> {
  const pack = doing === 'push' ? 'receivepack' : 'uploadpack';
  return checkConfig(dir, doing, () => (entry) => REPO_PROGRAM_KEY.test(entry.key), () => '', (entries) => programPins(entries, given, { name: remote, pack }), given);
}

/**
 * The keys of a repo's config that name a program git runs as it checks files out or merges them: a merge driver
 * (`merge.<name>.driver`, run for a file whose `.gitattributes` says `merge=<name>`) and a filter
 * (`filter.<name>.clean`, `smudge` and `process`, for `filter=<name>`), and a Git LFS extension
 * (`lfs.extension.<name>.clean` and `smudge`), which Git LFS's filter runs for a pointer that lists it. A branch an agent
 * made can carry the `.gitattributes`, or the pointer, that picks one.
 */
const CHECKOUT_PROGRAM_KEY = /^(merge\..+\.driver|filter\..+\.(clean|smudge|process)|lfs\.extension\..+\.(clean|smudge))$/i;

/**
 * Git LFS's own filter, as `git lfs install --local` writes it (with `--skip-smudge` too): a repo may keep it in its
 * config, as it runs the `git-lfs` on the user's PATH. Only under the name `lfs` exactly, as `git config --list` gives
 * it: a filter's name is case-sensitive, so `LFS` is another filter, for which none of Git LFS's own settings hold.
 */
const LFS_FILTER: Record<string, string[]> = {
  'filter.lfs.clean': ['git-lfs clean -- %f'],
  'filter.lfs.smudge': ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'],
  'filter.lfs.process': ['git-lfs filter-process', 'git-lfs filter-process --skip'],
};

/** The keys that turn Git LFS's filter on: with one set in any scope, a checkout runs `git-lfs`. */
const LFS_FILTER_ON = /^filter\.lfs\.(smudge|process)$/i;

/** A merge driver's program, `merge.<name>.driver`. */
const MERGE_DRIVER_KEY = /^merge\.(.+)\.driver$/i;

/**
 * Git's own merge drivers, which a `merge.<name>.driver` of the same name would replace, each as a program that merges
 * the same way: a three-way merge of the text, the same with both sides kept on a conflict, and none (a conflict, ours
 * kept). Also what a driver the config doesn't name runs as.
 */
const BUILTIN_MERGE_DRIVERS: Record<string, string> = {
  text: 'git merge-file --marker-size=%L %A %O %B',
  union: 'git merge-file --union --marker-size=%L %A %O %B',
  binary: 'false',
};

/** Where the attributes `.gitattributes` lines pick a filter or a merge driver: `filter=<name>`, `merge=<name>`. */
const PICKS = '(filter|merge)=[^[:space:]]+';

/** Where git reads the attributes of a checkout or merge from, beside the config's own attributes files. */
export interface AttributeSources {
  /** The commits or trees whose `.gitattributes` files it reads. */
  trees: string[];
  /** Whether it reads the worktree's own `.gitattributes` files (and the index's) too, as a merge or a restore does. */
  worktree?: boolean;
}

/** The most of an attributes file, or of the attributes the board greps, it reads: past it, it refuses. */
const ATTRIBUTES_LIMIT = 16 * 1024 * 1024;

/**
 * The text of the attributes file at `path`: empty when there is none (or `/dev/null`), an error when it can't be read
 * whole. An agent can name the path, or put a FIFO or a device there, so it is opened without waiting (`O_NONBLOCK`),
 * and only a plain file of at most `ATTRIBUTES_LIMIT` is read.
 */
async function attributesText(path: string | undefined): Promise<{ text: string } | { error: string }> {
  if (path === undefined || path === '/dev/null') return { text: '' };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { text: '' } : { error: `could not read the attributes file ${path}: ${String(error)}` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { error: `the attributes file ${path} isn't a plain file` };
    if (stat.size > ATTRIBUTES_LIMIT) return { error: `the attributes file ${path} is over ${ATTRIBUTES_LIMIT} bytes` };
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    return { error: `could not read the attributes file ${path}: ${String(error)}` };
  } finally {
    await handle.close();
  }
}

/**
 * The filter and merge driver names any attributes git reads in `dir` could pick: in the `.gitattributes` of
 * `sources`, the repo's `info/attributes`, and the attributes file the config names (`core.attributesFile`, else
 * git's default), which is returned too. A name read where none is picked costs only a pin.
 */
async function attributePicks(dir: string, entries: ConfigEntry[], given: NodeJS.ProcessEnv, sources: AttributeSources): Promise<AttributePicks | { error: string }> {
  // As text (`-a`): git reads a `.gitattributes` that grep would call binary (one with a NUL, or marked `-diff`).
  const grep = (flags: string[], trees: string[] = []) =>
    runGit(dir, ['grep', '-h', '-o', '-a', ...flags, '-E', PICKS, ...trees, '--', ':(glob)**/.gitattributes'], undefined, {}, { maxBuffer: ATTRIBUTES_LIMIT });
  const configured = lastValue(entries, 'core.attributesfile');
  const home = given.HOME ?? '';
  const defaultFile = given.XDG_CONFIG_HOME ? join(given.XDG_CONFIG_HOME, 'git', 'attributes') : home === '' ? undefined : join(home, '.config', 'git', 'attributes');
  if (configured !== undefined && configured.startsWith('~') && !configured.startsWith('~/')) return { error: `the board can't read core.attributesFile ${configured}, another user's` };
  const attributesFile = configured === undefined ? defaultFile : configured.startsWith('~/') ? join(home, configured.slice(2)) : resolve(dir, configured);
  const infoPath = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']);
  if (!infoPath.ok) return { error: `could not find the repo's info/attributes: ${infoPath.stderr}` };
  const found = await Promise.all([
    ...(sources.trees.length > 0 ? [grep([], sources.trees)] : []),
    ...(sources.worktree === true ? [grep(['--untracked', '--no-exclude-standard']), grep(['--cached'])] : []),
  ]);
  // Exit 1 with nothing said is no match; anything else that fails (a bad tree, output over the limit) could hide a name.
  const failed = found.find((result) => !result.ok && !(result.exitCode === 1 && result.stdout === '' && result.stderr === ''));
  if (failed !== undefined) return { error: `could not read the attributes it would use: ${failed.stderr || 'git grep failed'}` };
  const files = await Promise.all([attributesText(infoPath.stdout), attributesText(attributesFile)]);
  const unread = files.find((read) => 'error' in read);
  if (unread !== undefined && 'error' in unread) return unread;
  const text = [...found.map((result) => result.stdout), ...files.map((read) => ('text' in read ? read.text : ''))].join('\n');
  const filters = new Set<string>();
  const merges = new Set<string>();
  // Git reads an attributes line only as far as a NUL in it, so a name runs up to the first one.
  for (const [, kind, name] of text.matchAll(/(?:^|\s)(filter|merge)=([^\s\0]+)/g)) (kind === 'filter' ? filters : merges).add(name!);
  return { filters, merges, attributesFile };
}

/** The filter and merge driver names the attributes could pick, and the attributes file git reads (`attributePicks`). */
interface AttributePicks {
  filters: Set<string>;
  merges: Set<string>;
  attributesFile: string | undefined;
}

/**
 * The pins for a checkout or merge, on top of `programPins` (which Git LFS's downloads at checkout run): each filter
 * and merge driver the attributes could pick (`attributePicks`) set to what the checked config gives it. A filter's
 * `clean`, `smudge` and `process` as the config has them, or empty, which runs nothing, and its `required` as the
 * config has it, or false; a merge driver, git's own three among them, and the driver its inner merges use, as the
 * config has them, or as git's own merge (`BUILTIN_MERGE_DRIVERS`). The attributes file and `merge.default` (the
 * driver for a file the attributes pick none for) are pinned too, as git read them. Refused when the attributes can't
 * be read whole, as a name in them would go unpinned. Not held: a Git LFS extension, which a pointer lists.
 */
async function checkoutPins(dir: string, entries: ConfigEntry[], given: NodeJS.ProcessEnv, sources: AttributeSources): Promise<Pins | { refused: string }> {
  const programs = programPins(entries, given);
  const picks = await attributePicks(dir, entries, given, sources);
  if ('error' in picks) return { refused: picks.error };
  const { filters, merges, attributesFile } = picks;
  const mergeDefault = lastValue(entries, 'merge.default') ?? 'text';
  // Git takes a driver the config names before its own of that name, so its own three are pinned too.
  const drivers = [...new Set([...merges, mergeDefault, ...Object.keys(BUILTIN_MERGE_DRIVERS)])];
  // Git runs a filter's `clean` and `smudge` only while it has no `process`, an empty one included: so for a filter the
  // config gives those alone, `process` stays unpinned, and `after` looks for it.
  const has = (name: string, setting: string) => lastValue(entries, `filter.${name}.${setting}`) !== undefined;
  const openProcess = new Set([...filters].filter((name) => !has(name, 'process') && (has(name, 'clean') || has(name, 'smudge'))));
  const settings: Setting[] = [
    ...programs.settings,
    ...[...filters].flatMap((name): Setting[] => [
      ...(['clean', 'smudge', 'process'] as const)
        .filter((setting) => setting !== 'process' || !openProcess.has(name))
        .map((setting): Setting => [`filter.${name}.${setting}`, lastValue(entries, `filter.${name}.${setting}`) ?? '']),
      [`filter.${name}.required`, lastValue(entries, `filter.${name}.required`) ?? 'false'],
    ]),
    ...drivers.flatMap((name): Setting[] => [
      [`merge.${name}.driver`, lastValue(entries, `merge.${name}.driver`) ?? BUILTIN_MERGE_DRIVERS[name] ?? BUILTIN_MERGE_DRIVERS.text!],
      // The driver an inner merge (of merge bases) uses: unset, the driver itself.
      [`merge.${name}.recursive`, lastValue(entries, `merge.${name}.recursive`) ?? name],
    ]),
    ['merge.default', mergeDefault],
    ...(attributesFile === undefined ? [] : [['core.attributesFile', attributesFile] as const]),
  ];
  const holds = (key: string) => {
    const filter = FILTER_KEY.exec(key);
    if (filter !== null) return filters.has(filter[1]!) && !(filter[2]!.toLowerCase() === 'process' && openProcess.has(filter[1]!));
    const driver = MERGE_DRIVER_KEY.exec(key);
    if (driver !== null) return drivers.includes(driver[1]!);
    return REPO_PROGRAM_KEY.test(key) && programs.holds(key);
  };
  return { settings, env: programs.env, args: [], holds };
}

/**
 * Checks the config git reads in `dir` before the board goes to `doing` (as "make a worktree" or "merge"), a checkout
 * or merge that reads its attributes from `sources`: refused when the repo's own config names a merge driver or a filter
 * (`CHECKOUT_PROGRAM_KEY`), which git would run as the daemon, outside any agent's permissions. Git LFS's filter, as it
 * installs itself, stays allowed, and so does anything in the user's global and system config. But with Git LFS's filter
 * on, a checkout downloads the objects it lacks, as a fetch does, through the transfer agents, credential helpers and
 * ssh the config names: so then the keys a fetch is refused for (`REPO_PROGRAM_KEY`) are refused too. Checked, the
 * command runs with `checkoutPins`.
 */
export function checkCheckoutConfig(dir: string, doing: string, sources: AttributeSources, given: NodeJS.ProcessEnv = process.env): Promise<ConfigCheck> {
  return checkConfig(
    dir,
    doing,
    (entries) => {
      const lfs = entries.some(({ key }) => LFS_FILTER_ON.test(key));
      return ({ key, value }) => (CHECKOUT_PROGRAM_KEY.test(key) && !(LFS_FILTER[key] ?? []).includes(value)) || (lfs && REPO_PROGRAM_KEY.test(key));
    },
    (keys) => (keys.some((key) => REPO_PROGRAM_KEY.test(key)) ? " (as Git LFS's filter is on, and a checkout downloads its files the way a fetch does)" : ''),
    (entries) => checkoutPins(dir, entries, given, sources),
    given,
  );
}

/** A Git LFS extension's program: Git LFS's filter runs it for each file it cleans or smudges. */
const LFS_EXTENSION_KEY = /^lfs\.extension\..+\.(clean|smudge)$/i;

/** Git LFS's filter off altogether, whoever's config names it. */
const LFS_OFF = [
  ['filter.lfs.clean', ''],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.process', ''],
  ['filter.lfs.required', 'false'],
] as const;

/** The settings of a filter, `filter.<name>.<setting>`, as `git config --list` names them. */
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/i;

/**
 * The environment that turns off, for one git command, each filter program the repo's own config (local or worktree)
 * sets: that filter's `clean`, `smudge` or `process`, as the user's global or system config has it, or empty, which runs
 * nothing. Git LFS's own is the filter named `lfs` exactly: a filter's name is case-sensitive, so `LFS` is another
 * one, with no extensions of Git LFS's turned off with it. Only those the repo sets, as an empty `process` would stop the user's own `clean` too. The filter's
 * `required` is the user's, or false, so a status needn't fail for a filter turned off. When the repo's config sets a
 * Git LFS extension's program (`lfs.extension.<name>.clean` or `smudge`), which Git LFS's filter would run, that
 * filter is off too, the user's own included. Git LFS's own filter, as it installs
 * itself (`LFS_FILTER`), is left on, as is every filter only the user's config names. The settings go through
 * `GIT_CONFIG_COUNT` (after any in `given`, the environment the command runs with), not `-c`, as a filter's name may hold an `=`. A config that
 * can't be read gives nothing to add: git fails on it too, running no filter.
 */
export async function repoFiltersOffEnv(dir: string, given: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  const listed = await configEntries(dir);
  if ('error' in listed) return {};
  const user = new Map<string, string>();
  const repoSets = new Map<string, Set<string>>();
  for (const { scope, key, value } of listed.entries) {
    const match = FILTER_KEY.exec(key);
    if (match === null) continue;
    const setting = `filter.${match[1]}.${match[2]!.toLowerCase()}`;
    if (USER_SCOPES.has(scope)) user.set(setting, value);
    else if (REPO_SCOPES.has(scope) && !(match[1] === 'lfs' && (setting === 'filter.lfs.required' || (LFS_FILTER[setting] ?? []).includes(value)))) {
      const sets = repoSets.get(match[1]!) ?? new Set<string>();
      repoSets.set(match[1]!, sets.add(match[2]!.toLowerCase()));
    }
  }
  // Git LFS's filter, the user's own included, runs each extension the config lists for a file it cleans or smudges.
  const lfsExtensions = listed.entries.some(({ scope, key }) => REPO_SCOPES.has(scope) && LFS_EXTENSION_KEY.test(key));
  const settings = [
    ...[...repoSets]
      .filter(([name]) => !(lfsExtensions && name === 'lfs'))
      .flatMap(([name, sets]) =>
        ['clean', 'smudge', 'process', 'required']
          .filter((setting) => setting === 'required' || sets.has(setting))
          .map((setting) => {
            const key = `filter.${name}.${setting}`;
            return [key, user.get(key) ?? (setting === 'required' ? 'false' : '')] as const;
          }),
      ),
    ...(lfsExtensions ? LFS_OFF : []),
  ];
  return configCountEnv(settings, given);
}

/**
 * Runs `receive-pack` with hooks and fsmonitor off, for a push to a remote that is a local folder the user's own config
 * names (`localPushWhy`). Git runs that remote's `receive-pack` here, in a git of its own that doesn't get the daemon's
 * `-c` settings. Git runs it with a shell, appending the remote's path.
 */
const LOCAL_RECEIVE_PACK = '--receive-pack=git -c core.hooksPath=/dev/null -c core.fsmonitor=false receive-pack';

/**
 * Whether git could reach `url` as a folder on this machine. Only what is plainly elsewhere counts as not: a URL with a
 * scheme other than `file`, a remote helper's `<transport>::<address>` (a scheme-like word first, as git requires), or
 * ssh's `host:path` (a colon before any slash). Anything else is taken as a folder.
 */
export function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*(:\/\/|::)/i.test(url)) return false;
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return !(colon > 0 && (slash === -1 || colon < slash));
}

/** The keys that rewrite a remote's URL: `url.<base>.insteadOf` and `url.<base>.pushInsteadOf`. */
const URL_REWRITE_KEY = /^url\..+\.(push)?insteadof$/i;

/**
 * Whether a push to `url` stays in that folder: it, or its `.git`, is a repo, which git tries before `<folder>.git`.
 * Only a plain path or a `file://` one with no `%` counts; anything else is false.
 */
function isRepoFolder(url: string): boolean {
  const path = url.replace(/^file:\/\//i, '');
  if (path.includes('%') || !path.startsWith('/')) return false;
  const gitDir = (dir: string) =>
    existsSync(join(dir, 'HEAD')) && ['objects', 'refs'].every((each) => existsSync(join(dir, each)) && statSync(join(dir, each)).isDirectory());
  return gitDir(path) || existsSync(join(path, '.git'));
}

/**
 * Why the board won't push to `remote`, whose push URLs are `urls`, or undefined when it may. A push to a folder on this
 * machine runs that repo's `receive-pack`, which reads that repo's own config and runs its hooks: a repo an agent could
 * have made, and pointed the remote at from its worktree. So a local push URL is taken only when the user's own config
 * (global or system) produces it: as the remote's `url` or `pushurl`, or as the folder a `url.<folder>.insteadOf` or
 * `pushInsteadOf` rewrites to, inside that folder: no `..` or `%` after it, and not a sibling that only starts with its name. Anything else is refused, whatever named it: the repo's config, a
 * rewrite it sets, or a remote in the old `.git/remotes` and `.git/branches` files, which aren't config at all.
 */
async function localPushWhy(dir: string, remote: string, urls: string[]): Promise<string | undefined> {
  const local = urls.filter(isLocalRemoteUrl);
  if (local.length === 0) return undefined;
  const why = `the remote ${remote} is a folder on this machine that your own git config doesn't name, and a push there runs that repo's programs; the board won't push to it. Name it in your global ~/.gitconfig, or push yourself.`;
  const listed = await configEntries(dir);
  if ('error' in listed) return why;
  const urlKeys = new Set([`remote.${remote}.url`, `remote.${remote}.pushurl`].map((key) => key.toLowerCase()));
  const trustedUrls = new Set<string>();
  const trustedBases: string[] = [];
  for (const { scope, key, value } of listed.entries) {
    const rewrite = URL_REWRITE_KEY.test(key);
    const named = urlKeys.has(key.toLowerCase());
    if (REPO_SCOPES.has(scope) && (rewrite || (named && isLocalRemoteUrl(value)))) return why;
    if (!USER_SCOPES.has(scope)) continue;
    if (named) trustedUrls.add(value);
    // `url.<base>.insteadOf`: the base is the name between the first dot and the last.
    if (rewrite) trustedBases.push(key.slice(key.indexOf('.') + 1, key.lastIndexOf('.')));
  }
  // Past a trusted folder: a path inside it, so no `..`, and no `%`, which git decodes in a `file://` URL (`%2e%2e` is `..`).
  // The folder itself only when it is a repo: else git tries `<folder>.git` beside it too.
  const inside = (base: string, rest: string) =>
    (rest === '' ? isRepoFolder(base) : /[\\/]$/.test(base) || /^[\\/]/.test(rest)) && !rest.includes('%') && !rest.split(/[\\/]/).includes('..');
  const produced = (url: string) =>
    trustedUrls.has(url) || trustedBases.some((base) => base !== '' && url.startsWith(base) && inside(base, url.slice(base.length)));
  return local.every(produced) ? undefined : why;
}

/**
 * Pushes `from` (a commit or a ref) from `dir` to `remote`'s branch `to`, the way the board pushes a pull request's
 * branch: never forced, with no hooks, and never signed. Refused first when the repo's own config names a program git
 * would run (`checkRepoConfig`), or a local folder as the remote (`localPushWhy`); then its Git LFS objects go up
 * (`pushLfsObjects`), and a failed upload stops it. Both run with the checked config's pins, and fail, saying so, when
 * the config named a program no pin held, or a local folder, by the time they had run. A push to a folder the user's
 * own config names runs that repo's `receive-pack` with its hooks off too (`LOCAL_RECEIVE_PACK`).
 * Resolves with what went wrong in `stderr`, its own words first.
 */
export async function pushBranch(dir: string, remote: string, from: string, to: string): Promise<GitResult> {
  const checked = await checkRepoConfig(dir, 'push', remote);
  if ('refused' in checked) return { ok: false, stdout: '', stderr: checked.refused };
  const pushUrls = async (): Promise<{ urls: string[] } | { failed: GitResult }> => {
    const urls = await runGit(dir, ['remote', 'get-url', '--push', '--all', remote]);
    return urls.ok ? { urls: urls.stdout.split('\n').filter((url) => url !== '') } : { failed: urls };
  };
  const before = await pushUrls();
  if ('failed' in before) return before.failed;
  const local = await localPushWhy(dir, remote, before.urls);
  if (local !== undefined) return { ok: false, stdout: '', stderr: local };
  const toFolder = before.urls.length > 0 && before.urls.every(isLocalRemoteUrl);
  const lfs = await pushLfsObjects(dir, remote, from, checked.env);
  const pushed = !lfs.ok
    ? { ...lfs, stderr: `its Git LFS files: ${lfs.stderr}` }
    : await runGit(
        dir,
        // Hooks off there too, for a folder of the user's own; never for a server, which would refuse a receive-pack it didn't choose.
        // A server's push can't turn into one to a folder (whose receive-pack would run that repo's hooks) through a url written since the check.
        [...(toFolder ? [] : ['-c', 'protocol.file.allow=never']), 'push', '--no-verify', '--no-signed', ...(toFolder ? [LOCAL_RECEIVE_PACK] : checked.args), remote, `${from}:refs/heads/${to}`],
        undefined,
        checked.env,
      );
  const after = await pushUrls();
  const changed = (await checked.after()) ?? ('failed' in after ? undefined : await localPushWhy(dir, remote, after.urls));
  if (changed === undefined) return pushed;
  return { ok: false, stdout: pushed.stdout, stderr: `${pushed.ok ? 'it went out, but ' : ''}${changed}${pushed.ok ? '' : ` (and the push: ${pushed.stderr})`}` };
}

/**
 * Uploads the Git LFS objects `ref` needs to `remote`, which LFS's pre-push hook would have done for a push with hooks
 * on. Call it before pushing `ref` with `runGit`, with `env` the push's own (`CheckedConfig`). Succeeds with nothing done when `ref`'s tree tracks no file with LFS
 * (no `filter=lfs` in any of its `.gitattributes`), or this machine has no `git lfs`; fails, with its message, when the
 * upload does, as a push then would leave the remote with pointers to files it doesn't have.
 *
 * Also fails, uploading nothing, when a `.lfsconfig` Git LFS could read sets a key that could choose where to upload
 * (see `REFUSED_LFSCONFIG_KEY`): that file is part of the branch, so an agent could point the daemon's upload, and the
 * credentials git would offer for it, at a server of its choosing. Refused rather than pinned to origin's endpoint, as
 * pinning would mean redoing Git LFS's own working-out of that endpoint (ssh, aliases, the repo's own settings). The
 * check runs before `git lfs push`, which reads the files again: an agent still running in `dir` could write one in
 * between, a small window this doesn't close.
 */
export async function pushLfsObjects(dir: string, remote: string, ref: string, env: Record<string, string> = {}): Promise<GitResult> {
  const nothing = { ok: true, stdout: '', stderr: '' };
  const tracked = await runGit(dir, ['grep', '--quiet', '--fixed-strings', 'filter=lfs', ref, '--', ':(glob)**/.gitattributes']);
  if (!tracked.ok) return nothing;
  const installed = await runGit(dir, ['lfs', 'version']);
  if (!installed.ok) return nothing;
  const refusedKeys = await refusedLfsConfigKeys(dir, ref);
  if (refusedKeys.length > 0) {
    const stderr = `.lfsconfig sets ${refusedKeys.join(', ')}, which can choose the server Git LFS uploads to; the board won't upload with it. Remove those keys, or push this branch yourself.`;
    return { ok: false, stdout: '', stderr };
  }
  return runGit(dir, ['lfs', 'push', remote, ref], undefined, env);
}

/**
 * The `.lfsconfig` keys `pushLfsObjects` refuses. Current Git LFS takes three endpoint keys from that file: `lfs.url`,
 * `lfs.pushurl` and `remote.<name>.lfsurl`. It ignores `remote.<name>.lfspushurl` and `url.<base>.(push)insteadOf`
 * there, which are refused anyway, for an older Git LFS that read every key. Git LFS reads the file with `--includes`,
 * so `include.path` and `includeIf.<condition>.path` are refused too: the file they name can set any of the others.
 * Names come back from `git config` with the section and key lowercased and the subsection as written.
 */
const REFUSED_LFSCONFIG_KEY = /^(lfs\.(push)?url|remote\..+\.lfs(push)?url|url\..+\.(push)?insteadof|include\.path|includeif\..+\.path)$/i;

/**
 * The refused keys (`REFUSED_LFSCONFIG_KEY`) set in any `.lfsconfig` Git LFS might read for a push of `ref` from `dir`:
 * the worktree's file, which it reads first, then the index's, `HEAD`'s and `ref`'s. Includes aren't followed, as any
 * include is refused, and a read that fails still counts the keys git listed before it stopped (a malformed file lists
 * the entries above its bad line).
 */
async function refusedLfsConfigKeys(dir: string, ref: string): Promise<string[]> {
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  const sources = [
    ...(top.ok ? [['--file', join(top.stdout, '.lfsconfig')]] : []),
    ['--blob', ':.lfsconfig'],
    ['--blob', 'HEAD:.lfsconfig'],
    ['--blob', `${ref}:.lfsconfig`],
  ];
  const keys = new Set<string>();
  for (const source of sources) {
    const listed = await runGit(dir, ['config', '--no-includes', ...source, '--list', '--name-only']);
    for (const key of listed.stdout.split('\n')) if (REFUSED_LFSCONFIG_KEY.test(key)) keys.add(key);
  }
  return [...keys];
}
