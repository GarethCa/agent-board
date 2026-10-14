// Shell integration: a shell session says how each command it ran went, so a tab's dot can turn red when the
// last command failed. At each prompt the shell prints an OSC sequence of the daemon's own with the last exit status,
// which terminals ignore and the daemon reads from its output. bash (and sh, which is bash or dash) takes it from
// PROMPT_COMMAND in its environment; zsh from a precmd hook, sourced through a ZDOTDIR of the daemon's that sources the
// user's own startup files first, as VS Code's terminal does. Other shells (fish, a bare dash) say nothing: their dots
// only turn red when the shell exits non-zero.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The OSC the shell prints at each prompt: `ESC ] 6973 ; exit ; <status> BEL`. 6973 is no terminal's code. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const EXIT_OSC = /\x1b\]6973;exit;(\d+)\x07/g;

/** The last exit status a chunk of a shell's output reported, if any. */
export function lastExitStatus(data: string): number | undefined {
  let status: number | undefined;
  for (const match of data.matchAll(EXIT_OSC)) status = Number(match[1]);
  return status;
}

/** The user's own ZDOTDIR, kept for the daemon's zsh startup files to source the user's from. */
const USER_ZDOTDIR = 'AGENT_BOARD_USER_ZDOTDIR';

const REPORT = "builtin printf '\\033]6973;exit;%s\\007' \"$__ab_status\"";

/** Each file sources the user's own of the same name from their ZDOTDIR (or home), then hands back to this folder. */
const sourceUser = (file: string) =>
  `ZDOTDIR=$__ab_user\n[[ -f "$ZDOTDIR/${file}" ]] && builtin source "$ZDOTDIR/${file}"\nZDOTDIR=$__ab_dir\n`;

const ZSH_FILES: Record<string, string> = {
  '.zshenv': [
    '__ab_dir=$ZDOTDIR',
    `__ab_user=\${${USER_ZDOTDIR}:-$HOME}`,
    sourceUser('.zshenv'),
  ].join('\n'),
  '.zprofile': sourceUser('.zprofile'),
  '.zshrc': [
    // The system's zshrc ran just now, with ZDOTDIR still this folder: macOS's sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history,
    // which would move the user's history here. Put it where a plain shell has it, before their own .zshrc, which may
    // set it again.
    '[[ $HISTFILE == "$__ab_dir/.zsh_history" ]] && HISTFILE=$__ab_user/.zsh_history',
    sourceUser('.zshrc'),
    // First of the precmd hooks, so $? is still the last command's.
    `__ab_precmd() { local __ab_status=$?; ${REPORT}; }`,
    'precmd_functions=(__ab_precmd $precmd_functions)',
    // A shell that reads no .zlogin goes back to the user's ZDOTDIR here, so a zsh started from it is theirs.
    '[[ -o login ]] || ZDOTDIR=$__ab_user',
    '',
  ].join('\n'),
  '.zlogin': 'ZDOTDIR=$__ab_user\n[[ -f "$ZDOTDIR/.zlogin" ]] && builtin source "$ZDOTDIR/.zlogin"\n',
};

/**
 * The environment that turns the integration on for `shell`, writing the zsh startup files under `dir` the first time.
 * Empty for a shell it doesn't know. `env` is the environment the shell would otherwise get.
 */
export function shellIntegrationEnv(shell: string, dir: string, env: Record<string, string>): Record<string, string> {
  const name = basename(shell);
  if (name === 'bash' || name === 'sh') {
    // Ahead of any PROMPT_COMMAND the user exports; their rc files may still set their own over it.
    const theirs = env.PROMPT_COMMAND;
    const ours = `__ab_status=$?; ${REPORT}`;
    return { PROMPT_COMMAND: theirs ? `${ours}; ${theirs}` : ours };
  }
  if (name === 'zsh') {
    const folder = join(dir, 'zsh');
    mkdirSync(folder, { recursive: true });
    for (const [file, text] of Object.entries(ZSH_FILES)) writeFileSync(join(folder, file), text);
    return { ZDOTDIR: folder, ...(env.ZDOTDIR === undefined ? {} : { [USER_ZDOTDIR]: env.ZDOTDIR }) };
  }
  return {};
}
