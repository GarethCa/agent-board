import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { replayFetch, type HttpInteraction } from './http-fixtures.ts';

/**
 * Serves recorded interactions over HTTP on 127.0.0.1, for a process that can only be pointed at a URL (the app's
 * daemon, through `$AGENT_BOARD_LINEAR_API_URL`). A request is matched as if it had gone to `recordedUrl`; an
 * unmatched one gets a 500 naming it.
 */
export async function serveFixtures(
  interactions: readonly HttpInteraction[],
  recordedUrl: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const replay = replayFetch(interactions);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      replay
        .fetch(recordedUrl, { method: req.method, body: body === '' ? undefined : body })
        .then(async (response) => {
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(await response.text());
        })
        .catch((error: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(error.message);
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${new URL(recordedUrl).pathname}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
