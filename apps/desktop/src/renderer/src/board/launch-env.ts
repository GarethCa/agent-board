import { envPair } from '@agent-board/daemon/protocol';

/**
 * The env vars an agent starts with, from what the user typed: one NAME=value a line, read as `agent-board --env`
 * reads one (`envPair`), past the line's indent. Blank lines and lines starting with # are skipped. A later line for a
 * name wins.
 */
export function parseEnvLines(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '').trimStart();
    if (line.trim() === '' || line.startsWith('#')) continue;
    const pair = envPair(line);
    if (pair === undefined) {
      const name = line.includes('=') ? line.slice(0, line.indexOf('=')) : line;
      return { error: `Line ${index + 1} isn't NAME=value: ${name === '' ? 'it has no name' : `"${name}"`}.` };
    }
    env[pair.name] = pair.value;
  }
  return { env };
}
