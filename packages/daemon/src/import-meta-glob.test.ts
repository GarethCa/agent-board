import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Vitest's disk cache keys a module by its own text, so a glob's file list would go stale when a file is added. It
 * skips a module whose text contains `import.meta.glob(`; anything between the name and the paren hides that.
 */
it('writes every import.meta.glob call as `import.meta.glob(` so Vitest does not cache the module', () => {
  const root = new URL('../../../', import.meta.url);
  const sources: URL[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(url);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(url);
    }
  };
  for (const group of ['packages', 'apps']) {
    for (const pkg of readdirSync(new URL(`${group}/`, root))) walk(new URL(`${group}/${pkg}/src/`, root));
  }
  expect(sources.length).toBeGreaterThan(50);
  const hidden = sources.filter((url) =>
    readFileSync(url, 'utf8')
      .split('\n')
      .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /import\.meta\.glob(?!\()/.test(line)),
  );
  expect(hidden.map((url) => url.pathname)).toEqual([]);
});
