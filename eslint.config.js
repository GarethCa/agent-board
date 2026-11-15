import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/test-results/**', '**/test-results-visual/**', '**/playwright-report/**', '**/*.config.*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    // `import { type A } from './a'` still loads './a' under verbatimModuleSyntax, but madge (`pnpm cycles`) counts it
    // as type-only: written `import type { A }`, it is type-only in both.
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
  {
    files: ['apps/desktop/src/renderer/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Main answers only the app's own windows through the guard on ipcMain (main/ipc-guard.ts). A web contents' or a
    // frame's own `.ipc` would answer past it.
    files: ['apps/desktop/src/main/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.property.name='ipc'][property.name=/^(on|once|addListener|prependListener|prependOnceListener|handle|handleOnce)$/]",
          message: "Register IPC on ipcMain, which answers only the app's own windows (main/ipc-guard.ts), not on a web contents' or frame's own `.ipc`.",
        },
      ],
    },
  },
);
