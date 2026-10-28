import { describe, expect, it } from 'vitest';
import { codexComposerUp } from '../src/codex-screen.ts';

// Screens the real Codex TUI (codex-cli 0.162.0-alpha.17.2) drew as it started, no prompt given, as `screenLines`
// reads them: box drawing taken out, runs of spaces joined, its logo left out.
const HEADER = ['>_ OpenAI Codex (v0.162.0-alpha.17.2)'];

/** Its composer drawn while it loads, before a startup screen may take its place: with its shared daemon, or without. */
const LOADING = [...HEADER, 'loading', '', '', '› Ask Codex to do anything', '', '', '← for agents · ? for shortcuts'];
const LOADED = [...HEADER, '~/work/proj', '', '', '› Ask Codex to do anything', '', '', '? for shortcuts'];

/**
 * Its folder-trust screen, in a repo the user has not trusted in Codex. Its second row and footer depend on how it was
 * started: `2. Back to Agent Command Center` and `esc back` with its shared daemon, `2. Quit` and `esc quit` without.
 */
const FOLDER_TRUST = [
  '',
  'Folder access',
  '/work/proj',
  '',
  'Trust this folder? Codex can read, edit, and run files here, subject to your permission',
  'settings. Folder settings can run code automatically, even without a model request. Continue',
  'only if you trust these files. Your trust decision will be saved.',
  '',
  '› 1. Trust and continue',
  '2. Back to Agent Command Center',
  '',
  'enter continue · esc back',
];

/** Its review of hooks not yet trusted, with the pointer moved to the second row. */
const HOOKS_REVIEW = [
  '',
  'Hooks need review',
  '1 hook is new or changed.',
  'Hooks can run outside the sandbox after you trust them.',
  '',
  '1. Review hooks',
  '› 2. Trust all and continue',
  "3. Continue without trusting (hooks won't run)",
  '',
  'enter confirm · esc skip',
];

/** Up: its composer with the model and folder under it. */
const UP = [...HEADER, '~/work/proj', '', '', '› Ask Codex to do anything', '', 'gpt-5.5 high · ~/work/proj', '? for shortcuts'];
const UP_WARNED = [...UP.slice(0, -1), '? for shortcuts ⚠ 1 warning · f2 to view'];

describe('codexComposerUp', () => {
  it('reads its composer with the model and folder under it as up', () => {
    expect(codexComposerUp(UP)).toBe(true);
    expect(codexComposerUp(UP_WARNED)).toBe(true);
    expect(codexComposerUp(['› Explain this codebase', 'fake-model default · /private/tmp/work/proj…'])).toBe(true);
    expect(codexComposerUp(['› Ask Codex to do anything', 'o4-mini · ~'])).toBe(true);
  });

  it('reads its composer drawn as it loads as not up: a startup screen may still take its place', () => {
    expect(codexComposerUp(LOADING)).toBe(false);
    expect(codexComposerUp(LOADED)).toBe(false);
    expect(codexComposerUp([...LOADED.slice(0, -1), '? for shortcuts ⚠ 1 warning · f2 to view'])).toBe(false);
  });

  it('reads its composer with no status line, the shortcuts line straight under it (`status_line = []`), as not up', () => {
    expect(codexComposerUp([...HEADER, '~/work/proj', '› Ask Codex to do anything', '', '← for agents · ? for shortcuts 100% context left'])).toBe(false);
    expect(codexComposerUp(['› Ask Codex to do anything', 'Context 100% left · gpt-5.5 high · ~/work/proj'])).toBe(false);
  });

  it('reads a startup screen, whose pointer row looks like its prompt, as not up', () => {
    expect(codexComposerUp(FOLDER_TRUST)).toBe(false);
    expect(codexComposerUp(HOOKS_REVIEW)).toBe(false);
  });

  it('reads a startup screen drawn under an old composer as not up', () => {
    expect(codexComposerUp([...UP, ...FOLDER_TRUST])).toBe(false);
  });

  it('reads nothing, or a screen with no composer, as not up', () => {
    expect(codexComposerUp([])).toBe(false);
    expect(codexComposerUp(['codex is starting', 'gpt-5.5 high · ~/work/proj'])).toBe(false);
  });
});
