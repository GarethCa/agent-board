/** A tool's response as text: a shell's stdout and stderr, other objects as JSON. */
export function toolOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  const { stdout, stderr } = (response ?? {}) as { stdout?: unknown; stderr?: unknown };
  if (typeof stdout === 'string') return [stdout, stderr].filter((text) => typeof text === 'string' && text !== '').join('\n');
  return JSON.stringify(response);
}
