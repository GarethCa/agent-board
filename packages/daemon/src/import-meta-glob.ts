// The one Vite feature the daemon uses. Vite (electron-vite) and Vitest inline the matched files at build time.
// Not generic: Vitest's disk cache skips a file only when its text has `import.meta.glob(`, and a type argument
// (`glob<string>(`) hides that, so a new file in the folder would be served from the cache's old list.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

export {};
