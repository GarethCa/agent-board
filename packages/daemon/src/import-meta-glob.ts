// The one Vite feature the daemon uses. Vite (electron-vite) and Vitest inline the matched files at build time.
declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, T>;
  }
}

export {};
