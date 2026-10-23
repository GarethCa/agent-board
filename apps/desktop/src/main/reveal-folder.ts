import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { shell } from 'electron';

/**
 * Shows the folder `path` in the OS file manager, selected in its parent. It reveals rather than opens: opening a
 * directory with a bundle extension (`Foo.app`) would launch it.
 */
export function revealFolder(path: string): void {
  if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error(`not a folder: ${path}`);
  shell.showItemInFolder(path);
}
