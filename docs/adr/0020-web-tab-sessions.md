---
status: accepted
---
# Web tabs keep logins in one shared session

Web tabs share one Electron session kept on disk, so cookies, site storage and logins outlast closing a tab and restarting the app, as a browser's do. Until now each tab had a partition of its own, in memory only, so every new tab and every restart started signed out. That was a privacy default; for a tab that mostly shows the user's own dev servers, staging sites and dashboards, signing in again each time was the bigger cost.

Everything else the lockdown does stays (`web-lockdown.ts`): no Node, no preload, a sandbox, no devtools or dialogs, no permission or device, no download, https and this machine's http only, and only a page on this machine reaching this machine. The lockdown is set per session and keeps its per-page state per page, so it locks the shared session once and holds for every tab in it. Plan views keep their own locked, in-memory partition (`plan-lockdown.ts`).

- **Settings › Advanced › Web tabs.** **Keep logins between sessions**, on by default, is a daemon setting (`keepWebLogins`). The main process reads it as each web tab's page is made: off, the page gets an in-memory partition of its own, as a private tab's. If the setting can't be read (the daemon restarting), the page is private too, and says so.
- **Turning it off, from Settings or from anywhere else (the CLI, the daemon's socket)**, is acted on by the main process as it hears the change: every page open in the shared session is made again in a partition of its own, at the address it was at, signed out, and the shared session is cleared. Nothing open writes to it after, nor does a page being opened as the switch goes. It is cleared again as the app starts with the setting off (on its first connection to the daemon), should anything have been left in it.
- **Clear browsing data…** clears the shared session's cookies, storage, cache and HTTP auth logins (`web-tab:clearData`, which only the board's window may ask for), and leaves the switch as it is. A page open at the time keeps what it shows until it reloads. Both ask first.
- **Private web tabs.** The + menu's **Private web…** opens a web tab marked `private` in its window's layout. It keeps the old behaviour: a partition of its own, in memory, cleared as the tab closes or its window reloads, and never the shared session, whatever the setting says. Its address row says Private, as does any tab whose page is private for another reason.
- **A shared session is never cleared by a tab going.** Closing a tab, its window reloading or a hand-off expiring takes only the page; only a private tab's (or a plan view's) own partition is cleared with it.

## What agents can do with a web tab

Persistent logins make a web tab act as the signed-in user, so we checked what an agent can do with one:

- **Read, drive or screenshot it: nothing.** No daemon method or board command reads a web tab's page, runs script in it, sends it input or captures it. Zone screenshots draw the board in a hidden window that never draws a session's contents, so it has no web tabs, and a window's capture never includes the web views laid over it.
- **Open one, and learn where it ended up.** An agent's pins and the links it prints open in a web tab on the user's click. Anything on the daemon's socket could also write a window layout holding a web tab at a URL of its choosing (`shell.setWindowLayout`), which then loads with the user's cookies, and read the layout back (`shell.windowLayout`): the address the tab ended up at, after redirects, kept without its query or fragment, so a sign-in's code or token isn't in it. Its origin and path still tell whether the user is signed in there (a `/login` page or an inbox) and can name the account. The page's content and cookies never come back. A redirect from an https site to this machine without a click is still stopped (`mayRequest`), so a local server can't catch a sign-in's callback that way.

So agent-opened tabs don't get a partition of their own. The request an agent can make is one `open https://…` in any shell already makes in the user's own browser; what it can learn more is the final address, which we accept for a tab the user opened from an agent's link expecting to be signed in. Settings says both, under the switch.

## At rest

The shared session's cookies sit in the app's data folder, readable by anything running as the user, agents included. The packaged app turns on Electron's cookie encryption fuse (`electronFuses.enableCookieEncryption` in `electron-builder.yml`), so they are encrypted with a key in the macOS keychain ("agent-board Safe Storage"), as Chrome's are, rather than kept in plain text.

- **The protection is partial.** The app's `runAsNode` and inspect fuses stay on (the daemon and the hook forwarder run as this executable), and the keychain item trusts this executable, so a process running as the user can run the app's own binary to decrypt the store. The fuse stops a plain read of the cookie file, not a determined process running as the user.
- **The keychain asks.** The build is unsigned, so macOS may ask to let agent-board use its keychain, after each rebuild: Always Allow keeps logins; Deny leaves the store unreadable, and every launch starts signed out. Settings says so.
- **A store is only ever read the way it was written.** The fuse is one-way: a store written encrypted is garbage to a build without it. The shared partition is named for how its cookies are kept: `persist:web` in the packaged app, with the fuse, and `persist:web-plain` unpackaged (the development app and the test suite, which share the packaged app's data folder but not its fuse). Should the packaged app's fuse ever be turned off, its partition is renamed in the same change (`SHARED_PARTITION` in `web-tabs.ts`), so the encrypted store is never read, and that change deletes it (`<userData>/Partitions/web`): the user is signed out once, with nothing corrupt.

## Considered options

- **Keep a partition per tab, in memory** — the old default. Safest at rest, but every tab and restart signs out.
- **A partition per tab, kept on disk** — logins outlast a restart but not a new tab, and each closed tab leaves data behind with nothing to clear it by.
- **A separate, in-memory partition for tabs an agent opens** — the fallback had agents been able to drive tabs. They can't, and a pin or printed link is opened by the user, who expects it signed in.
- **Leave cookies in plain text** — no keychain prompt, but a cookie file every agent can read, worse than the user's own browser.
