// A file the main process loads at run time: electron-vite copies it into the build and the import is its path.
declare module '*?asset' {
  const path: string;
  export default path;
}
