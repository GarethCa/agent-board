import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A page a web tab test loads: its title, and a link to go on from it. */
const page = (title: string, body = '') => `<!doctype html><title>${title}</title><h1>${title}</h1>${body}`;

/**
 * A dev server on 127.0.0.1 for the web tab's tests, so they load nothing from the internet. `/` links
 * to `/next` (with a sign-in's code and token, as a callback has) and holds an empty frame, as a dev server's overlay does; `/to-file`, `/to-data` and `/to-http` (plain
 * http elsewhere) redirect where a web tab may not go; `/download` is an attachment. `/login` signs in with a cookie
 * that lasts a day, as a site's does, and `/account` says whether the request carried it. `hits` lists the paths asked for.
 */
export async function serveWebPages(): Promise<{ url: string; hits(): string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    hits.push(path);
    const redirect = (location: string) => response.writeHead(302, { location }).end();
    if (path === '/to-file') return redirect('file:///etc/passwd');
    if (path === '/to-data') return redirect('data:text/html,<h1>data</h1>');
    if (path === '/to-http') return redirect('http://example.com/');
    if (path === '/login') return response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'login=yes; Max-Age=86400; Path=/; HttpOnly' }).end(page('Signed in'));
    if (path === '/account') return response.writeHead(200, { 'content-type': 'text/html' }).end(page(/(^|;\s*)login=yes/.test(request.headers.cookie ?? '') ? 'Signed in' : 'Signed out'));
    if (path === '/download') return response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }).end('bytes');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(path === '/next' ? page('Next page') : page('Dev home', '<a id="next" href="/next?code=secret#access_token=t">Next</a><iframe srcdoc="<p>an overlay</p>"></iframe>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => [...hits],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
