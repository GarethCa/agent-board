import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react';
import type { WebSurface } from '@agent-board/daemon/window-layout';
import { keptWebUrl, WEB_TAB_RULE, webTabLabel, webTabUrl } from '@agent-board/daemon/web-url';
import type { WebTabKey, WebTabState } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { Button, ErrorText, IconButton, Input } from '../ui';
import { newWebTabs, type LocalServer } from './tabs';
import { useWebViewBounds } from './use-web-view';

/** How long a tab's page stays at a URL before the tab keeps it: a page rewriting its URL as it scrolls is kept once. */
const KEEP_URL_MS = 1000;

interface WebTabProps {
  web: WebSurface;
  /** Whether its pane shows it, and its window shows its body. */
  visible: boolean;
  /** The local dev servers a tab with no page yet offers, as links. */
  servers: LocalServer[];
  /** Whether its pane has the keyboard, and whether a window opening may give it away: a new tab's address takes it when both. */
  keyboard: boolean;
  autoFocus: boolean;
  /** Its page went somewhere else: the URL its tab keeps (`keptWebUrl`), to reload at the next start. */
  onNavigate(url: string): void;
  /** Its page took the keyboard: its pane is the window's focused one. */
  onFocus(): void;
  /** One of the window's pane keys pressed in the page, for its pane; false for any other key. */
  onPaneKey(key: WebTabKey): boolean;
}

/**
 * A web tab: a page the main process draws in a locked-down web view of its own over the tab's area,
 * mainly an agent's dev server on localhost. An address row over it: back, forward, reload, its URL (edited and checked
 * with the rule its page is held to) and Open in browser. Opened, the page loads its URL afresh; taken away (the tab
 * closing, the window closing or going elsewhere) the page goes with it. A new tab has no page (`web.url` is empty):
 * its address is focused over a blank page that offers the local dev servers, and its view is made when a URL is first sent.
 */
export function WebTab({ web, visible, servers, keyboard, autoFocus, onNavigate, onFocus, onPaneKey }: WebTabProps) {
  const host = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  /** The URL the tab's page is made at: what it was kept at, or the first one typed in a new tab, which has none until then. */
  const [opened, setOpened] = useState<string | undefined>(web.url === '' ? undefined : web.url);
  const [state, setState] = useState<WebTabState>({ url: web.url, title: '', canGoBack: false, canGoForward: false, loading: web.url !== '', focused: false });
  const [typed, setTyped] = useState<string>();
  const [problem, setProblem] = useState<string>();
  /** The URL the page was last at, to tell a page gone elsewhere from one that only changed its title. */
  const lastUrl = useRef(web.url);
  const latest = useRef({ onNavigate, onFocus, onPaneKey });
  latest.current = { onNavigate, onFocus, onPaneKey };
  const drawn = useWebViewBounds(web.id, host, visible);

  useEffect(() => {
    if (opened === undefined) return;
    /** The URL the tab keeps, and where the page went that it hasn't kept yet, which it will once the page stays there. */
    let kept = keptWebUrl(web.url);
    lastUrl.current = opened;
    let toKeep: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keep = () => {
      clearTimeout(timer);
      if (toKeep !== undefined) latest.current.onNavigate(toKeep);
      toKeep = undefined;
    };
    const close = window.agentBoard.webTabs.open(web.id, opened, {
        onState: (next) => {
          // What the page says now outdates what the address row last said: a block, or a page gone elsewhere.
          if (next.problem !== undefined || next.url !== lastUrl.current) setProblem(undefined);
          lastUrl.current = next.url;
          setState(next);
          const at = keptWebUrl(next.url);
          if (at !== undefined && at !== kept) {
            kept = toKeep = at;
            clearTimeout(timer);
            timer = setTimeout(keep, KEEP_URL_MS);
          }
          if (next.focused) latest.current.onFocus();
        },
        // One of the window's own keys, pressed in the page: a pane key acts on its pane, any other (⌘[, ⌘I) as if pressed in the tab.
        onKey: (key) => {
          if (!latest.current.onPaneKey(key)) host.current?.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }));
        },
      });
    return () => {
      close();
      keep();
    };
    // Opened once, at the URL it has then (or is first sent): later URLs are the page's own, kept for the next start.
  }, [web.id, opened]);

  const run = (action: () => Promise<void>) => {
    setProblem(undefined);
    action().catch((error: unknown) => setProblem(errorMessage(error)));
  };
  /** Makes the tab's page at `url`, the first it has: the address row shows it at once, and nothing said of an earlier address stays. */
  const openAt = (url: string) => {
    setTyped(undefined);
    setProblem(undefined);
    setState((now) => ({ ...now, url, loading: true }));
    setOpened(url);
  };
  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = webTabUrl(typed ?? state.url);
    if (url === undefined) {
      setProblem(WEB_TAB_RULE);
      return;
    }
    if (opened === undefined) {
      openAt(url);
      return;
    }
    setTyped(undefined);
    run(() => window.agentBoard.webTabs.load(web.id, url));
  };
  const blank = opened === undefined;
  // A new tab's address takes the keyboard while its pane has it: as it mounts only if the user just opened it (a window
  // opening restored or expanding doesn't ask for it), and whenever its pane is focused after.
  const mounting = useRef(true);
  useEffect(() => {
    const first = mounting.current;
    mounting.current = false;
    const justOpened = first && newWebTabs.delete(web.id);
    if (blank && keyboard && (!first || autoFocus || justOpened)) address.current?.focus();
  }, [blank, keyboard]);
  const shownProblem = problem ?? state.problem;
  return (
    <div className="web-view" data-testid="web-view" data-web-tab={web.id} aria-busy={state.loading}>
      <form className="web-head" onSubmit={go}>
        <IconButton icon={<ArrowLeft />} aria-label="Back" size="xs" disabled={!state.canGoBack} onClick={() => run(() => window.agentBoard.webTabs.back(web.id))} />
        <IconButton icon={<ArrowRight />} aria-label="Forward" size="xs" disabled={!state.canGoForward} onClick={() => run(() => window.agentBoard.webTabs.forward(web.id))} />
        <IconButton icon={<RotateCw />} aria-label="Reload" size="xs" disabled={blank} onClick={() => run(() => window.agentBoard.webTabs.reload(web.id))} />
        <Input
          size="sm"
          className="web-address"
          data-testid="web-address"
          aria-label="Address"
          placeholder={blank ? 'Type a URL, or pick a local server below' : undefined}
          ref={address}
          spellCheck={false}
          value={typed ?? state.url}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => setTyped(undefined)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Nothing typed in a new tab: the bar lets go of the keyboard.
            if (blank && !typed) {
              event.currentTarget.blur();
              return;
            }
            if (typed === undefined) return;
            event.stopPropagation();
            setTyped(undefined);
          }}
        />
        {/* Its name is its tooltip: a tooltip of the window's would be drawn under the page. */}
        <IconButton icon={<ExternalLink />} aria-label="Open in browser" size="xs" disabled={blank} onClick={() => run(() => window.agentBoard.webTabs.openInBrowser(web.id))} />
      </form>
      {state.offered !== undefined && (
        <div className="web-offer" data-testid="web-offer" role="status">
          <span className="web-offer-text">
            The page asked to open <code>{state.offered}</code>
          </span>
          <Button size="xs" variant="primary" onClick={() => {
              const shown = state.offered;
              if (shown !== undefined) run(() => window.agentBoard.webTabs.openOffered(web.id, shown));
            }}>
            Open in browser
          </Button>
          <Button size="xs" variant="ghost" onClick={() => run(() => window.agentBoard.webTabs.dismissOffered(web.id))}>
            Dismiss
          </Button>
        </div>
      )}
      {shownProblem !== undefined && (
        <div className="web-problem" data-testid="web-problem">
          <ErrorText>{shownProblem}</ErrorText>
        </div>
      )}
      <div className="web-page" ref={host} data-testid="web-page" data-drawn={drawn || undefined}>
        {/* Under the page, seen only while it is hidden (something is over it, or dragged across it). */}
        {blank ? (
          <div className="web-blank" data-testid="web-blank">
            <Globe className="web-blank-globe" aria-hidden />
            <p className="web-blank-title">{servers.length === 0 ? 'No local servers running' : 'Running on this machine'}</p>
            {servers.length === 0 ? (
              <p className="web-blank-hint">Start a dev server in a shell and it is listed here, or type an address above.</p>
            ) : (
              <ul className="web-servers">
                {servers.map((server) => (
                  <li key={server.port}>
                    <button type="button" className="web-server" data-testid="web-server" onClick={() => openAt(server.url)}>
                      localhost:{server.port} <small>{server.shell}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="web-blank-rule">https anywhere · http on this machine only</p>
          </div>
        ) : (
          <span className="web-page-under" aria-hidden>
            <Globe />
            {state.title || webTabLabel(state.url)}
          </span>
        )}
      </div>
    </div>
  );
}
