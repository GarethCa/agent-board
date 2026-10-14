// How the board names a folder: a shell tile's folder chip, a group's default repo, a picker's rows.

/** A folder as the board shows it: `~` for the home directory (`home`), else its own name. */
export function folderLabel(path: string, home: string | undefined): string {
  if (path === home) return '~';
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
