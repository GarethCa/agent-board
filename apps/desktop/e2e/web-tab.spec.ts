import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { serveWebPages } from './web-server.ts';

const tabs = (page: Page) => sessionWindow(page).getByTestId('session-tab');
const tabNamed = (page: Page, name: string) => tabs(page).filter({ has: page.getByRole('tab', { name, exact: true }) });
const webView = (page: Page) => sessionWindow(page).getByTestId('web-view');

/** The web tabs' pages over the app's windows, as the main process lays them out. */
const webViews = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().flatMap((window) =>
      window.contentView.children.map((view) => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds(), visible: view.getVisible() })),
    ),
  );

/** The one web tab's page, as the main process has it. */
async function theWebView(app: ElectronApplication) {
  const views = await webViews(app);
  expect(views).toHaveLength(1);
  return views[0]!;
}

/** The page loaded in a web tab, as Playwright drives it: the app's other page than the board, at `url`. */
async function webPage(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url().startsWith(url))).toBe(true);
  return app.windows().find((page) => page.url().startsWith(url))!;
}

/** Waits until the web tab's page is drawn exactly over its area of the window, its address row's part excepted. */
async function expectDrawnOver(app: ElectronApplication, window: Page): Promise<void> {
  await expect
    .poll(async () => {
      const box = (await webView(window).getByTestId('web-page').boundingBox())!;
      const { bounds, visible } = await theWebView(app);
      return visible && [bounds.x - box.x, bounds.y - box.y, bounds.width - box.width, bounds.height - box.height].every((gap) => Math.abs(gap) <= 1);
    })
    .toBe(true);
}

/** The URL the daemon keeps for the shell tile's window's web tab. */
const keptWebUrl = (page: Page, shellId: string) =>
  page.evaluate((id) => window.agentBoard.shells.windowLayout({ kind: 'shell', id }).then((layout) => JSON.stringify(layout).match(/"url":"([^"]*)"/)?.[1]), shellId);

/** Sends every link the app opens in the OS browser to a list instead, read back with `opened`. */
async function stubBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => void opened.push(url);
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as { opened?: string[] }).opened);

/** Types `typed` into the web tab's address row and goes there. */
async function goTo(window: Page, typed: string): Promise<void> {
  const address = webView(window).getByTestId('web-address');
  await address.fill(typed);
  await address.press('Enter');
}

test("a web tab from + Web… shows a local dev server's page, locked down: no file, data or javascript, no redirect away, no window, permission, download or devtools; it follows its pane as it splits, hides behind a dialog, is kept across a restart by its URL and goes with its data when closed", async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  let { app, window } = await launch(dataDir, appEnv);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(tabs(window)).toHaveCount(1);

    // + › Web… asks where, with localhost filled in, and checks the answer with the rule the page is held to.
    await sessionWindow(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: 'Web…' }).click();
    const ask = window.getByRole('dialog', { name: 'Open a web tab' });
    const address = ask.getByRole('textbox', { name: 'Address' });
    await expect(address).toHaveValue('http://localhost:3000/');
    await address.fill('file:///etc/passwd');
    await ask.getByRole('button', { name: 'Open' }).click();
    await expect(ask.getByRole('alert')).toContainText('A web tab shows https pages');
    await address.fill(server.url);
    await ask.getByRole('button', { name: 'Open' }).click();
    await expect(ask).toBeHidden();

    // A tab named after its host, showing the page over its area of the window.
    const host = new URL(server.url).host;
    await expect(tabNamed(window, host)).toHaveAttribute('data-active', 'true');
    const page = await webPage(app, server.url);
    await expect(page.locator('h1')).toHaveText('Dev home');
    await expect(webView(window).getByTestId('web-address')).toHaveValue(server.url);
    // Its frame of nothing (a dev server's overlay) is no page elsewhere, and loads from its dev server as the page does.
    await expect(webView(window).getByTestId('web-problem')).toHaveCount(0);
    await page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.srcdoc = `<script>fetch('${url}srcdoc-own')</script><img src="${url}srcdoc-image">`;
      document.body.append(frame);
    }, server.url);
    await expect.poll(() => server.hits()).toEqual(expect.arrayContaining(['/srcdoc-own', '/srcdoc-image']));
    await expectDrawnOver(app, window);

    // No file, data or javascript page from its address row.
    for (const typed of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'http://example.com/']) {
      await goTo(window, typed);
      await expect(webView(window).getByTestId('web-problem')).toContainText('A web tab shows https pages');
    }
    // Nor from the page itself: Chromium refuses it a local file, and the tab plain http elsewhere, saying so.
    const problem = webView(window).getByTestId('web-problem');
    await page.evaluate(() => void (location.href = 'file:///etc/passwd'));
    await page.evaluate(() => void (location.href = 'http://example.com/'));
    await expect(problem).toContainText('Blocked http://example.com/');
    // Nor by a redirect: each is stopped where it would go, never reaching it.
    await goTo(window, `${server.url}to-http`);
    await expect(problem).toContainText('Blocked http://example.com/');
    for (const to of ['to-file', 'to-data']) {
      await goTo(window, `${server.url}${to}`);
      await expect(problem).toContainText(`${server.url}${to}`);
      expect((await theWebView(app)).url.startsWith(server.url)).toBe(true);
    }
    await goTo(window, server.url);
    await expect(page.locator('h1')).toHaveText('Dev home');
    await expect(problem).toHaveCount(0);
    // Nor a frame inside it, nor a blob of its own making.
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = 'data:text/html,<h1>inside</h1>';
      document.body.append(frame);
    });
    await expect(problem).toContainText('Blocked data:text/html');
    expect(page.frames().some((frame) => frame.url().startsWith('data:'))).toBe(false);
    await page.evaluate(() => void (location.href = URL.createObjectURL(new Blob(['<h1>blob</h1>'], { type: 'text/html' }))));
    await expect(problem).toContainText('Blocked blob:');
    expect((await theWebView(app)).url).toBe(server.url);
    await goTo(window, server.url);
    await expect(page.locator('h1')).toHaveText('Dev home');

    // window.open opens no window, and nothing in the OS browser by itself, however often a page asks (here on a timer):
    // the tab offers the last https page asked for, which opens in the OS browser only once clicked.
    await stubBrowser(app);
    const windowsBefore = app.windows().length;
    await page.evaluate(() => {
      let asked = 0;
      const timer = setInterval(() => {
        globalThis.open(`https://example.com/spam${asked}`);
        if (++asked === 5) clearInterval(timer);
      }, 20);
    });
    const offer = webView(window).getByTestId('web-offer');
    await expect(offer).toContainText('https://example.com/spam4');
    expect(await page.evaluate((url) => globalThis.open(`${url}next`) === null, server.url)).toBe(true);
    expect(await opened(app)).toEqual([]);
    expect(app.windows()).toHaveLength(windowsBefore);
    await offer.getByRole('button', { name: 'Open in browser' }).click();
    await expect.poll(() => opened(app)).toEqual(['https://example.com/spam4']);
    await expect(offer).toHaveCount(0);

    // A page's alert, confirm or prompt shows no dialog of the app's.
    await app.evaluate(({ dialog }) => {
      const shown: string[] = [];
      (globalThis as { shown?: string[] }).shown = shown;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        shown.push(JSON.stringify(args.at(-1)));
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      dialog.showMessageBoxSync = ((...args: unknown[]) => (shown.push(JSON.stringify(args.at(-1))), 0)) as typeof dialog.showMessageBoxSync;
    });
    await page.evaluate(() => {
      alert('agent-board: session expired');
      confirm('really?');
    });
    expect(await app.evaluate(() => (globalThis as { shown?: string[] }).shown)).toEqual([]);

    // Every permission is denied: notifications, geolocation, the camera.
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
    expect(await page.evaluate(() => new Promise<number>((resolve) => navigator.geolocation.getCurrentPosition(() => resolve(0), (error) => resolve(error.code))))).toBe(1);
    expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (error: Error) => error.name))).toBe('NotAllowedError');

    // A download is cancelled, and devtools never open.
    const devToolsOpened = await app.evaluate(({ BrowserWindow }) => {
      const [view] = BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
      // Heard after the lockdown, which has stopped it by then.
      view!.webContents.session.on('will-download', (event) => ((globalThis as { downloaded?: string }).downloaded = event.defaultPrevented ? 'cancelled' : 'started'));
      view!.webContents.openDevTools();
      return view!.webContents.isDevToolsOpened();
    });
    expect(devToolsOpened).toBe(false);
    await page.evaluate((url) => {
      const link = document.createElement('a');
      link.href = `${url}download`;
      link.click();
    }, server.url);
    await expect.poll(() => app.evaluate(() => (globalThis as { downloaded?: string }).downloaded)).toBe('cancelled');
    await expect(page.locator('h1')).toHaveText('Dev home');

    // A page asking "Leave this page?" never keeps the tab on it.
    await page.evaluate(() => addEventListener('beforeunload', (event) => event.preventDefault()));
    await page.locator('h1').click();
    await goTo(window, `${server.url}next`);
    await expect(page.locator('h1')).toHaveText('Next page');
    await goTo(window, server.url);
    await expect(page.locator('h1')).toHaveText('Dev home');

    // A link in the page goes on, and its address row follows.
    await page.locator('#next').click();
    await expect(page.locator('h1')).toHaveText('Next page');
    await expect(webView(window).getByTestId('web-address')).toHaveValue(`${server.url}next?code=secret#access_token=t`);
    await expect(webView(window).getByTestId('web-problem')).toHaveCount(0);
    await webView(window).getByRole('button', { name: 'Back' }).click();
    await expect(webView(window).getByTestId('web-address')).toHaveValue(server.url);
    await webView(window).getByRole('button', { name: 'Forward' }).click();
    await expect(webView(window).getByTestId('web-address')).toHaveValue(`${server.url}next?code=secret#access_token=t`);

    // A dialog over the window hides the page, and it comes back as it closes; so does another tab showing.
    await sessionWindow(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: 'Web…' }).click();
    await expect.poll(async () => (await theWebView(app)).visible).toBe(false);
    await window.getByRole('dialog', { name: 'Open a web tab' }).getByRole('button', { name: 'Cancel' }).click();
    await expectDrawnOver(app, window);
    await tabNamed(window, 'Shell 1').getByRole('tab').click();
    await expect.poll(async () => (await theWebView(app)).visible).toBe(false);
    await tabNamed(window, host).getByRole('tab').click();
    await expectDrawnOver(app, window);

    // Dragged onto its pane's right edge it splits the window, and the page follows it into its new pane.
    const before = (await theWebView(app)).bounds;
    const view = sessionWindow(window).locator('[data-testid="session-tab-view"]:not([hidden])');
    const box = (await view.boundingBox())!;
    const from = (await tabNamed(window, host).boundingBox())!;
    await window.mouse.move(from.x + Math.min(20, from.width / 2), from.y + from.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 16 });
    // Hidden while dragged, so the drag and where it would land stay the window's.
    await expect.poll(async () => (await theWebView(app)).visible).toBe(false);
    await window.mouse.up();
    await expect(sessionWindow(window).getByTestId('window-pane')).toHaveCount(2);
    await expect(sessionWindow(window).getByTestId('window-pane').nth(1).getByTestId('session-tab')).toHaveText([host]);
    await expectDrawnOver(app, window);
    const after = (await theWebView(app)).bounds;
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.width).toBeLessThan(before.width);
    // The same page, not loaded again.
    await expect(page.locator('h1')).toHaveText('Next page');

    // Kept across a restart by where it went, once it has stayed there a moment, but not its sign-in's code or token, and
    // loaded there afresh.
    const shellId = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await expect.poll(() => keptWebUrl(window, shellId)).toBe(`${server.url}next`);
    await app.close();
    ({ app, window } = await launch(dataDir, appEnv));
    await expect(tabNamed(window, host)).toHaveCount(1);
    const restored = await webPage(app, `${server.url}next`);
    await expect(restored.locator('h1')).toHaveText('Next page');
    await expect(webView(window).getByTestId('web-address')).toHaveValue(`${server.url}next`);
    await expectDrawnOver(app, window);

    // Closed, its page goes, and its partition's cookies with it.
    await restored.evaluate(() => void (document.cookie = 'seen=1; max-age=3600'));
    const tabId = (await webView(window).getAttribute('data-web-tab'))!;
    const cookies = () => app.evaluate(({ session }, id) => session.fromPartition(`web-tab-${id}`).cookies.get({}).then((all) => all.length), tabId);
    expect(await cookies()).toBe(1);
    // ⌘W in the page closes its tab, as anywhere in the window, never the app's window.
    // Sent as the OS sends a key press: Playwright's reach the page through devtools, which the app never hears.
    await app.evaluate(({ BrowserWindow }, mac) => {
      const [view] = BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
      view!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: mac ? ['meta'] : ['control', 'shift'] });
    }, process.platform === 'darwin');
    await expect(tabNamed(window, host)).toHaveCount(0);
    await expect(sessionWindow(window)).toBeVisible();
    await expect.poll(() => webViews(app)).toEqual([]);
    await expect.poll(cookies).toBe(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("a local address in a shell's output opens in a web tab of its window on a ⌘-click", async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    const terminal = sessionWindow(window).getByTestId('session-terminal');
    await terminal.click();
    // The address alone on a line of output, as a dev server prints it.
    await window.keyboard.type(`printf '%s\\n' ${server.url}`);
    await window.keyboard.press('Enter');
    const line = terminal.locator('.xterm-rows > div').filter({ hasText: /^http:/ });
    await expect(line).toHaveCount(1);
    const box = (await line.boundingBox())!;
    const onLink = { x: box.x + 30, y: box.y + box.height / 2 };

    // A plain click is the terminal's.
    await window.mouse.move(onLink.x, onLink.y);
    await window.mouse.click(onLink.x, onLink.y);
    await expect(tabs(window)).toHaveCount(1);

    // A ⌘-click opens it in a web tab, beside the shell.
    const command = process.platform === 'darwin' ? 'Meta' : 'Control';
    await window.keyboard.down(command);
    await window.mouse.click(onLink.x, onLink.y);
    await window.keyboard.up(command);
    const host = new URL(server.url).host;
    await expect(tabNamed(window, host)).toHaveAttribute('data-active', 'true');
    const page = await webPage(app, server.url);
    await expect(page.locator('h1')).toHaveText('Dev home');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
