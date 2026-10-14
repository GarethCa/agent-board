/** What to tell the user about a failure: the error's message (the daemon's, through the preload), or the value. */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The daemon's message, without the "Error invoking remote method …: Error:" wrapping IPC adds. */
export function ipcErrorMessage(error: unknown): string {
  return errorMessage(error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}
