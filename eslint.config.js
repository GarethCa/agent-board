import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/test-results/**', '**/test-results-visual/**', '**/playwright-report/**', '**/*.config.*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/desktop/src/renderer/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
