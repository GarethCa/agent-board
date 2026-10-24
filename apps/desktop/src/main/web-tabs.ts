import { app, BrowserWindow, ipcMain, session as sessions, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isWebTabUrl, WEB_TAB_RULE } from '@agent-board/daemon/web-url';
import { WEB_TAB_IPC, type WebTabBounds, type WebTabKey, type WebTabState } from '../preload/api';
import { headless } from './background';
import { openWebLink, openWebTabLink } from './links';
import { webKey } from './web-keys';
import { passkeyNotice, probePasskeys } from './web-passkeys';
import { lockDownContents, lockDownSession } from './web-lockdown';
import { lockDownPlanContents, lockDownPlanSession, PLAN_URL } from './plan-lockdown';

/** A tab's id, as it names its partition: what the renderer makes with `crypto.randomUUID()`, and nothing that isn't a name. */
const TAB_ID = /^[\w-]{1,64}$/;

/** Chromium's code for a load cut short, by a new one or by the lockdown: not a failure to show. */
const ABORTED = -3;

/** Chromium's code for a load the lockdown's request rule (`mayRequest`) cancelled. */
const BLOCKED_BY_CLIENT = -20;

/**
 * How long a page handed off to another window (`handOff`) waits for it to open the tab before it goes: its partition
 * stays, for the tab to load in afresh when its window opens. Shorter in tests (`AGENT_BOARD_HAND_OFF_MS`).
 */
const HAND_OFF_MS = (!app.isPackaged && Number(process.env.AGENT_BOARD_HAND_OFF_MS)) || 30_000;

/** Each web tab's session partition: its own, and in memory only, so nothing it keeps outlives the app. */
const partitionOf = (tabId: string) => `web-tab-${tabId}`;

/** What the tab says of a page it stopped going to `url`. */
const blocked = (url: string) => `Blocked ${url}. ${WEB_TAB_RULE}`;

/** What a plan's view says of a navigation, window or request it stopped. */
const planBlocked = (url: string) => `Blocked ${url}: a plan's page stays on the plan, offline, and opens nothing.`;

/** Each plan view's page, by tab id, which its partition serves (`lockDownPlanSession`). */
const planPages = new Map<string, string>();

/** Partitions being cleared, by tab id: a tab opened again meanwhile waits for its own to be empty. */
const clearing = new Map<string, Promise<void>>();

/** Clears a tab's partition: its cookies, storage and cache. Electron keeps the session itself until the app quits. */
function clearPartition(tabId: string): Promise<void> {
  const partition = sessions.fromPartition(partitionOf(tabId));
  const cleared = (async () => {
    await partition.clearStorageData();
    await partition.clearCache();
  })().finally(() => {
    if (clearing.get(tabId) === cleared) clearing.delete(tabId);
  });
  clearing.set(tabId, cleared);
  return cleared;
}

interface WebTab {
  view: WebContentsView;
  /** The window it is drawn in, and the renderer that opened it, which hears how it does and lays it out: another's once it is handed off. */
  window: BrowserWindow;
  owner: WebContents;
  /** The URL asked for, until the page has one of its own. */
  asked: string;
  problem: string | undefined;
  /** The https page the page last asked to open in a new window, offered for the user to open. */
  offered: string | undefined;
  /** Whether its page has asked for a passkey, which the tab may not be able to serve, and the user hasn't dismissed that (`web-passkeys.ts`). */
  passkey: ReturnType<typeof passkeyNotice>;
  /** Whether it shows an agent's plan, which goes nowhere: `load` takes it nowhere either. */
  plan: boolean;
}

/** How a kind of page is opened and held: what it loads, what it says of what it stopped, and its lockdown. */
interface ViewKind {
  asked: string;
  plan: boolean;
  blocked(url: string): string;
  lockSession(session: Electron.Session): void;
  lockContents(contents: WebContents, onBlocked: (url: string) => void, onOffer: (url: string) => void): void;
}

/** A web page at `url`: https and this machine's http only (`web-lockdown.ts`). */
const webKind = (url: string): ViewKind => ({
  asked: url,
  plan: false,
  blocked,
  lockSession: lockDownSession,
  lockContents: (contents, onBlocked, onWindowOpen) => lockDownContents(contents, { onBlocked, onWindowOpen }),
});

/** An agent's HTML plan, served from memory as `planPages` holds it for `tabId`, offline (`plan-lockdown.ts`). */
const planKind = (tabId: string): ViewKind => ({
  asked: PLAN_URL,
  plan: true,
  blocked: planBlocked,
  lockSession: (session) => lockDownPlanSession(session, () => planPages.get(tabId)),
  lockContents: (contents, onBlocked) => lockDownPlanContents(contents, onBlocked),
});

/**
 * The web tabs' IPC: each tab's page is a `WebContentsView` of its own over the tab's area of the window
 * whose renderer opened it, which places it (`setBounds`) and hides it. Locked down (`web-lockdown.ts`): no Node, a
 * sandbox, no preload, no devtools, no dialogs, a partition of its own, https and this machine's http only. Its page
 * goes when its renderer takes it away, reloads or closes; its partition's data when the tab is closed (`forget`), or
 * its renderer reloads or closes, as nothing there can show it again. A tab moving to another window (slice
 * 4) is handed off first (`handOff`): its page waits, hidden and kept from its window's going, for the window that
 * opens the tab next, which takes the page as it is. Its one injection is the passkey probe (`web-passkeys.ts`): a script
 * in the page, never a preload, that logs when it explicitly asks for a passkey.
 */
export function registerWebTabIpc({ isBoard }: { isBoard(contents: WebContents): boolean }): void {
  const tabs = new Map<string, WebTab>();
  /** Where each tab's renderer last placed its page, kept for one placed before its page was made (its effects' order). */
  const placed = new Map<string, WebTabBounds | null>();
  /** The tabs being opened while their partition clears, each with its own mark: one taken away meanwhile is not made. */
  const opening = new Map<string, symbol>();
  /** The renderers whose going is already watched, so each takes its pages with it once. */
  const watched = new WeakSet<WebContents>();
  const lockedSessions = new WeakSet<Electron.Session>();
  /** Pages handed off to another window, by tab id: each with the key it had, and its time to go if no window takes it. */
  const handedOff = new Map<string, { tab: WebTab; from: string; expiry: ReturnType<typeof setTimeout> }>();
  const keyOf = (owner: WebContents, tabId: string) => `${owner.id}:${tabId}`;

  /** The key of the tab `tabId` names for the renderer that sent `event`; undefined for anything that isn't a tab's id. */
  const keyFor = (event: IpcMainEvent | IpcMainInvokeEvent, tabId: unknown): string | undefined =>
    typeof tabId === 'string' && TAB_ID.test(tabId) ? keyOf(event.sender, tabId) : undefined;
  const tabOf = (event: IpcMainEvent | IpcMainInvokeEvent, tabId: unknown): WebTab | undefined => {
    const key = keyFor(event, tabId);
    return key === undefined ? undefined : tabs.get(key);
  };

  const stateOf = (tab: WebTab): WebTabState => {
    const contents = tab.view.webContents;
    return {
      url: contents.getURL() || tab.asked,
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      focused: contents.isFocused(),
      ...(tab.problem === undefined ? {} : { problem: tab.problem }),
      ...(tab.offered === undefined ? {} : { offered: tab.offered }),
      ...(tab.passkey.shown ? { passkey: true } : {}),
    };
  };
  const tell = (tabId: string, tab: WebTab) => {
    if (!tab.owner.isDestroyed() && !tab.view.webContents.isDestroyed()) tab.owner.send(WEB_TAB_IPC.changed, tabId, stateOf(tab));
  };

  /** Draws the tab's page at `bounds`, in its window's own page's CSS pixels as that is zoomed; hides it for null. */
  const place = (tab: WebTab, bounds: WebTabBounds | null) => {
    if (bounds === null || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      tab.view.setVisible(false);
      return;
    }
    const zoom = tab.owner.getZoomFactor();
    tab.view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
    tab.view.setVisible(true);
  };

  const destroy = (key: string) => {
    opening.delete(key);
    placed.delete(key);
    const tab = tabs.get(key);
    if (tab === undefined) return;
    tabs.delete(key);
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  };
  /** Whether the tab's page lives on elsewhere: handed off, or taken by another window since. */
  const livesOn = (tabId: string) => handedOff.has(tabId) || [...tabs.keys()].some((key) => key.endsWith(`:${tabId}`));
  /** Its renderer gone or reloading, each of its tabs' pages goes, and its partition's data with it: not one that lives on elsewhere. */
  const destroyAllOf = (owner: WebContents) => {
    const prefix = `${owner.id}:`;
    for (const key of new Set([...tabs.keys(), ...placed.keys()])) {
      if (!key.startsWith(prefix)) continue;
      destroy(key);
      if (livesOn(key.slice(prefix.length))) continue;
      planPages.delete(key.slice(prefix.length));
      void clearPartition(key.slice(prefix.length)).catch(() => {});
    }
  };
  /** Its pages go with the renderer: when it goes, and when it reloads, as nothing there lays them out any more. */
  const watch = (owner: WebContents) => {
    if (watched.has(owner)) return;
    watched.add(owner);
    owner.once('destroyed', () => destroyAllOf(owner));
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) destroyAllOf(owner);
    });
  };

  /**
   * The page handed off goes: no window took it, as the window it went to isn't open. Its partition stays: the tab is
   * still in that window's layout, and loads afresh in it, signed in as it was, when it opens.
   */
  const expire = (tabId: string) => {
    const waiting = handedOff.get(tabId);
    if (waiting === undefined) return;
    handedOff.delete(tabId);
    placed.delete(waiting.from);
    if (!waiting.tab.window.isDestroyed()) waiting.tab.window.contentView.removeChildView(waiting.tab.view);
    if (!waiting.tab.view.webContents.isDestroyed()) waiting.tab.view.webContents.close();
  };

  /** Moves a page handed off into `window`, for the renderer `owner`, as the tab `key`: shown where that renderer placed it, and told how it is. */
  const adopt = (tabId: string, owner: WebContents, window: BrowserWindow, key: string) => {
    const { tab, expiry } = handedOff.get(tabId)!;
    clearTimeout(expiry);
    handedOff.delete(tabId);
    if (tab.window !== window) {
      if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view);
      window.contentView.addChildView(tab.view);
    }
    tab.window = window;
    tab.owner = owner;
    watch(owner);
    tabs.set(key, tab);
    place(tab, placed.get(key) ?? null);
    tell(tabId, tab);
  };

  /**
   * Makes the tab's page for the renderer that sent `event`, for a web page at `url` or an agent's HTML plan (`plan`):
   * its view, locked down for what it shows, over the tab's area, or its page as it was when handed off from another
   * window. A plan is served from memory (`planPages`), and a reload serves it again.
   */
  const openView = async (event: IpcMainInvokeEvent, tabId: string, page: { url: string } | { plan: string }) => {
    const owner = event.sender;
    const key = keyOf(owner, tabId);
    // Handed off from another window: its page comes as it is, where it had got to. One that went with the window it
    // waited in can't: the tab loads afresh, in the partition it had.
    if (handedOff.get(tabId)?.tab.view.webContents.isDestroyed() === true) {
      const { expiry, from } = handedOff.get(tabId)!;
      clearTimeout(expiry);
      handedOff.delete(tabId);
      placed.delete(from);
    }
    if ('plan' in page) planPages.set(tabId, page.plan);
    if (handedOff.has(tabId)) {
      const window = BrowserWindow.fromWebContents(owner);
      if (window === null) throw new Error('no window to show a web tab in');
      if (tabs.get(key) !== undefined) destroy(key);
      adopt(tabId, owner, window, key);
      return;
    }
    // Its window reloaded, its partition may still be clearing: its page starts on an empty one, unless taken away first.
    const pending = clearing.get(tabId);
    if (pending !== undefined) {
      const mark = Symbol(tabId);
      opening.set(key, mark);
      await pending.catch(() => {});
      if (opening.get(key) !== mark || owner.isDestroyed()) return;
    }
    const window = BrowserWindow.fromWebContents(owner);
    if (window === null) throw new Error('no window to show a web tab in');
    const bounds = placed.get(key);
    destroy(key);
    if (bounds !== undefined) placed.set(key, bounds);
    watch(owner);
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionOf(tabId),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        devTools: false,
        // No alert, confirm or prompt: a page's would be a modal of the app's over the window, in words it chose.
        disableDialogs: true,
        // Nor dictionaries fetched for it from the web.
        spellcheck: false,
        // Tests paint every window offscreen (main/background.ts), and its pages with it.
        offscreen: headless,
      },
    });
    window.contentView.addChildView(view);
    const kind = 'url' in page ? webKind(page.url) : planKind(tabId);
    const tab: WebTab = { view, window, owner, asked: kind.asked, problem: undefined, offered: undefined, passkey: passkeyNotice(() => tell(tabId, tab)), plan: kind.plan };
    tabs.set(key, tab);
    place(tab, placed.get(key) ?? null);

    const contents = view.webContents;
    const session = contents.session;
    if (!lockedSessions.has(session)) {
      lockedSessions.add(session);
      kind.lockSession(session);
    }
    kind.lockContents(
      contents,
      (url) => {
        tab.problem = kind.blocked(url);
        tell(tabId, tab);
      },
      (target) => {
        tab.offered = target;
        tell(tabId, tab);
      },
    );
    if (!kind.plan) {
      probePasskeys(contents, process.platform, tab.passkey.asked);
    }
    const changed = () => tell(tabId, tab);
    contents.on('did-start-loading', changed);
    contents.on('did-stop-loading', changed);
    contents.on('page-title-updated', changed);
    contents.on('did-navigate-in-page', changed);
    contents.on('focus', changed);
    contents.on('blur', changed);
    contents.on('did-navigate', () => {
      tab.problem = undefined;
      tab.passkey.clear();
      changed();
    });
    contents.on('did-fail-load', (_event, code, description, failed, isMainFrame) => {
      if (!isMainFrame || code === ABORTED) return;
      tab.problem = code === BLOCKED_BY_CLIENT ? kind.blocked(failed) : `Could not load ${failed} (${description}).`;
      changed();
    });
    contents.on('before-input-event', (input, key) => {
      const action = webKey(key);
      if (action === undefined) return;
      input.preventDefault();
      // A held key acts once, as in the window.
      if (key.isAutoRepeat) return;
      if (action === 'reload') contents.reload();
      else if (action === 'hardReload') contents.reloadIgnoringCache();
      else if (!tab.owner.isDestroyed()) {
        const pressed: WebTabKey = { key: key.key, code: key.code, metaKey: key.meta, ctrlKey: key.control, shiftKey: key.shift, altKey: key.alt };
        // ⌘K opens the switcher over the window, whose field takes the keyboard from the page.
        if (key.code === 'KeyK') tab.owner.focus();
        tab.owner.send(WEB_TAB_IPC.key, tabId, pressed);
      }
    });
    void contents.loadURL(kind.asked).catch(() => {});
  };

  ipcMain.handle(WEB_TAB_IPC.open, async (event, tabId: unknown, url: unknown) => {
    if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw new Error(`not a web tab's id: ${String(tabId)}`);
    if (typeof url !== 'string' || !isWebTabUrl(url)) throw new Error(blocked(String(url)));
    await openView(event, tabId, { url });
  });

  // An agent's HTML plan, from the renderer, which read it from the daemon: drawn as a web tab's page is, but
  // served from memory and locked down harder (plan-lockdown.ts).
  ipcMain.handle(WEB_TAB_IPC.openPlan, async (event, tabId: unknown, html: unknown) => {
    if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw new Error(`not a plan view's id: ${String(tabId)}`);
    if (typeof html !== 'string') throw new Error('a plan is HTML text');
    await openView(event, tabId, { plan: html });
  });

  ipcMain.on(WEB_TAB_IPC.setBounds, (event, tabId: unknown, bounds: WebTabBounds | null) => {
    const key = keyFor(event, tabId);
    if (key === undefined) return;
    const tab = tabs.get(key);
    // Hiding a page not made yet, or gone, needs nothing kept.
    if (tab === undefined && bounds === null) placed.delete(key);
    else placed.set(key, bounds);
    if (tab !== undefined) place(tab, bounds);
  });

  ipcMain.handle(WEB_TAB_IPC.load, (event, tabId: unknown, url: unknown) => {
    const tab = tabOf(event, tabId);
    if (tab === undefined || tab.plan) return;
    if (typeof url !== 'string' || !isWebTabUrl(url)) throw new Error(blocked(String(url)));
    tab.asked = url;
    tab.problem = undefined;
    void tab.view.webContents.loadURL(url).catch(() => {});
  });
  ipcMain.handle(WEB_TAB_IPC.focus, (event, tabId: unknown) => tabOf(event, tabId)?.view.webContents.focus());
  ipcMain.handle(WEB_TAB_IPC.back, (event, tabId: unknown) => tabOf(event, tabId)?.view.webContents.navigationHistory.goBack());
  ipcMain.handle(WEB_TAB_IPC.forward, (event, tabId: unknown) => tabOf(event, tabId)?.view.webContents.navigationHistory.goForward());
  ipcMain.handle(WEB_TAB_IPC.reload, (event, tabId: unknown) => {
    const tab = tabOf(event, tabId);
    if (tab === undefined) return;
    // A page that never loaded has nothing to reload: what was asked is loaded again.
    if (tab.view.webContents.getURL() === '') void tab.view.webContents.loadURL(tab.asked).catch(() => {});
    else tab.view.webContents.reload();
  });
  ipcMain.handle(WEB_TAB_IPC.openInBrowser, (event, tabId: unknown) => {
    const tab = tabOf(event, tabId);
    return tab === undefined ? undefined : openWebTabLink(tab.view.webContents.getURL() || tab.asked);
  });
  // The page the page asked to open, once the user clicks for it, and only the one the tab showed them: never one the
  // renderer names, nor one the page asked for since.
  ipcMain.handle(WEB_TAB_IPC.openOffered, async (event, tabId: unknown, shown: unknown) => {
    const tab = tabOf(event, tabId);
    const offered = tab?.offered;
    if (tab === undefined || offered === undefined) return;
    if (shown !== offered) throw new Error('the page asked to open another page meanwhile: look again');
    tab.offered = undefined;
    tell(tabId as string, tab);
    await openWebLink(offered);
  });
  ipcMain.handle(WEB_TAB_IPC.dismissOffered, (event, tabId: unknown) => {
    const tab = tabOf(event, tabId);
    if (tab === undefined) return;
    tab.offered = undefined;
    tell(tabId as string, tab);
  });
  ipcMain.handle(WEB_TAB_IPC.dismissPasskey, (event, tabId: unknown) => tabOf(event, tabId)?.passkey.clear());
  ipcMain.handle(WEB_TAB_IPC.close, (event, tabId: unknown) => {
    const key = keyFor(event, tabId);
    if (key !== undefined) destroy(key);
  });
  // Asked by the board's window, which makes every move, or by the tab's own window, popping out or in: the tab is found
  // by its id alone, and no other window may take another's page.
  ipcMain.handle(WEB_TAB_IPC.handOff, (event, tabId: unknown) => {
    if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) return;
    if (!isBoard(event.sender) && tabs.get(keyOf(event.sender, tabId)) === undefined) throw new Error('only the board or its own window hands a web tab off');
    const waiting = handedOff.get(tabId);
    if (waiting !== undefined) {
      clearTimeout(waiting.expiry);
      waiting.expiry = setTimeout(() => expire(tabId), HAND_OFF_MS);
      return;
    }
    const key = [...tabs.keys()].find((each) => each.endsWith(`:${tabId}`));
    if (key === undefined) return;
    const tab = tabs.get(key)!;
    tabs.delete(key);
    tab.view.setVisible(false);
    handedOff.set(tabId, { tab, from: key, expiry: setTimeout(() => expire(tabId), HAND_OFF_MS) });
  });
  ipcMain.handle(WEB_TAB_IPC.cancelHandOff, (event, tabId: unknown) => {
    if (typeof tabId !== 'string') return;
    const waiting = handedOff.get(tabId);
    if (waiting === undefined) return;
    if (!isBoard(event.sender) && waiting.tab.owner !== event.sender) throw new Error('only the board or its own window hands a web tab back');
    const { tab, from } = waiting;
    // Its window gone meanwhile, nothing can show it again.
    if (tab.owner.isDestroyed() || tab.window.isDestroyed()) {
      expire(tabId);
      return;
    }
    adopt(tabId, tab.owner, tab.window, from);
  });
  ipcMain.handle(WEB_TAB_IPC.forget, async (event, tabId: unknown) => {
    const key = keyFor(event, tabId);
    if (key === undefined) return;
    destroy(key);
    planPages.delete(tabId as string);
    await clearPartition(tabId as string);
  });
}
