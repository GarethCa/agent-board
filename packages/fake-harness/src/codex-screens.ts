/**
 * What the Codex TUI draws as it starts, copied from the real one (codex-cli 0.162.0-alpha.17.2) started with no
 * prompt. It draws its composer at once, as it loads; a startup screen it needs answered (folder trust, a review of
 * hooks not yet trusted) then takes the composer's place; once every such screen is through, it draws the composer
 * again with its status line under it: its model, its reasoning effort and its folder, as the board sets it
 * (`tui.status_line`). It keeps both drawn through every turn. It fires `SessionStart` only with its first prompt, so
 * that status line is the only sign its session is up.
 */

/** The startup screens the fake can show before its session is up (`FAKE_HARNESS_START_SCREEN`). */
export const CODEX_START_SCREENS = ['folder-trust', 'hooks-review'] as const;
export type CodexStartScreen = (typeof CODEX_START_SCREENS)[number];

/** Its composer, holding its placeholder. */
const CODEX_COMPOSER = '› Ask Codex to do anything';

/** Its composer as it loads: no status line under it yet. */
export function codexLoadingComposer(): string[] {
  return ['', CODEX_COMPOSER, '', '  ← for agents · ? for shortcuts'];
}

/** Its composer once its session is up, its status line naming `model` and `cwd` under it. */
export function codexComposer(model: string, cwd: string): string[] {
  return ['', CODEX_COMPOSER, '', `  ${model} default · ${cwd}`, '  ← for agents · ? for shortcuts'];
}

/**
 * The startup screen `screen`, in `cwd`, its pointer on its first row; Enter answers it. Its folder trust is the one
 * Codex draws with its shared daemon, as the board starts it (`2. Quit` and `esc quit` without the daemon).
 */
export function codexStartScreen(screen: CodexStartScreen, cwd: string): string[] {
  if (screen === 'folder-trust') {
    return [
      '',
      '  Folder access',
      `  ${cwd}`,
      '',
      '  Trust this folder? Codex can read, edit, and run files here, subject to your permission',
      '  settings. Folder settings can run code automatically, even without a model request. Continue',
      '  only if you trust these files. Your trust decision will be saved.',
      '',
      '› 1. Trust and continue',
      '  2. Back to Agent Command Center',
      '',
      '  enter continue · esc back',
    ];
  }
  return [
    '',
    '  Hooks need review',
    '  1 hook is new or changed.',
    '  Hooks can run outside the sandbox after you trust them.',
    '',
    '› 1. Review hooks',
    '  2. Trust all and continue',
    "  3. Continue without trusting (hooks won't run)",
    '',
    '  enter confirm · esc skip',
  ];
}

export function isCodexStartScreen(value: string): value is CodexStartScreen {
  return (CODEX_START_SCREENS as readonly string[]).includes(value);
}
