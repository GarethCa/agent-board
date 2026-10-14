// A daemon from before `daemon.stop` (and build identity) existed, as every daemon was until build identity came in: it answers
// `daemon.health`, says `daemon.stop` is not a method, and shuts down on SIGTERM. Run as a child process by
// stop.test.ts, so stopDaemon's SIGTERM fallback signals a real process. Node built-ins only.
//
//   node old-daemon.ts <socket> <lock> <liveSessions> [leave-lock]
//
// With `leave-lock` it dies on SIGTERM without releasing the lock, as a crashed shutdown would.
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const [socketPath = '', lockPath = '', liveSessions = '0', mode] = process.argv.slice(2);
writeFileSync(lockPath, String(process.pid));
const server = createServer((socket) => {
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const { id, method } = JSON.parse(buffered.slice(0, end)) as { id: number; method: string };
      buffered = buffered.slice(end + 1);
      const reply =
        method === 'daemon.health'
          ? { result: { version: '0.0.0', protocolVersion: 1, pid: process.pid, liveSessions: Number(liveSessions) } }
          : { error: { code: -32601, message: `unknown method ${method}` } };
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...reply })}\n`);
    }
  });
});
server.listen(socketPath, () => console.log('listening'));
process.once('SIGTERM', () => {
  rmSync(socketPath, { force: true });
  if (mode !== 'leave-lock') rmSync(lockPath, { force: true });
  process.exit(0);
});
