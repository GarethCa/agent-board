// Stylesheets are bundled by Vite. Not `vite/client`: its `import.meta.glob` clashes with the daemon's narrower one.
declare module '*.css';
// An asset Vite bundles as a file, never as a data: URL, which the Content-Security-Policy refuses.
declare module '*?no-inline' {
  const url: string;
  export default url;
}
