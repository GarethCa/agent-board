import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.fixture.ts'],
    globalSetup: ['../../../src/vitest/global-setup.ts'],
    setupFiles: ['../../../src/vitest/setup.ts'],
  },
});
