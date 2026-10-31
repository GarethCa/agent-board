import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bell, Bot, ChevronRight, Gauge, LayoutDashboard, Search, SlidersHorizontal, UserRound, Wrench } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { ExternalHooksToggle } from '../board/ExternalHooksToggle';
import { HeldPayloadsSetting } from '../board/HeldPayloadsSetting';
import { daemonStatusText, useDaemonStatus } from '../DaemonStatus';
import { useSimplified } from '../design';
import { storedValue } from '../stored-value';
import { Hint, useToast } from '../ui';
import { useLiveLists } from '../windows/use-live-lists';
import { AppearanceSetting } from './AppearanceSetting';
import { ArrangeSpacingSetting } from './ArrangeSpacingSetting';
import { AgentNoteLookSetting, ClickOpensSetting, ConnectionsSetting, CrewLookSetting } from './BoardViewSettings';
import { ChatStyleSetting } from './ChatStyleSetting';
import { ClickableLinksSetting } from './ClickableLinksSetting';
import { CliInstallSetting } from './CliInstallSetting';
import { CompactWindowSetting } from './CompactWindowSetting';
import { HarnessPathSettings } from './HarnessPathSettings';
import { KeyboardSetting } from './KeyboardSetting';
import { NotificationsSetting } from './NotificationsSetting';
import { OpensOnSetting } from './OpensOnSetting';
import { SETTINGS_GROUPS, settingsPaneFrom, settingsPaneText, type SettingsGroupId, type SettingsHome, type SettingsPane } from './settings-ia';
import { searchable, searchSettings, type SettingsHit } from './settings-search';
import { SimplifiedDesignSetting } from './SimplifiedDesignSetting';
import { UsagePacingSetting, UsagePlanSetting, UsageThresholdsSetting } from './UsageSetting';
import { WebTabsSetting } from './WebTabsSetting';

type OnError = (action: string) => (error: unknown) => void;

/** The pane the window last showed, which it opens on next time: kept per user, in every window's storage. */
const lastPane = storedValue('agent-board.settings-pane');

const GROUP_ICONS: Record<SettingsGroupId, ReactNode> = {
  general: <SlidersHorizontal aria-hidden />,
  board: <LayoutDashboard aria-hidden />,
  agents: <Bot aria-hidden />,
  alerts: <Bell aria-hidden />,
  usage: <Gauge aria-hidden />,
  accounts: <UserRound aria-hidden />,
  advanced: <Wrench aria-hidden />,
};

/** How many agents are muted, which notify of nothing: kept live, as the board's tiles mute and unmute them. */
function MutedNotificationsSetting({ onError }: { onError: OnError }) {
  const { agents } = useLiveLists();
  return <NotificationsSetting muted={agents.filter((agent) => agent.muted).length} onError={onError} />;
}

/** Settings › Agents › Chat: under the Simplified design, the view windows open on first, then the chat's style. */
function AgentsChatSettings() {
  return (
    <>
      {useSimplified() && <OpensOnSetting />}
      <ChatStyleSetting />
    </>
  );
}

function DaemonStatusSetting() {
  return <Hint data-testid="daemon-details">{daemonStatusText(useDaemonStatus())}</Hint>;
}

/** What each section draws: every control in `SETTINGS_CONTROLS` is in the section it names as its home. */
function sectionBody(home: SettingsHome, onError: OnError): ReactNode {
  switch (home) {
    case 'general.design':
      return <SimplifiedDesignSetting onError={onError} />;
    case 'general.appearance':
      return <AppearanceSetting onError={onError} />;
    case 'general.keyboard':
      return <KeyboardSetting />;
    case 'board.opening':
      return <ClickOpensSetting />;
    case 'board.connections':
      return <ConnectionsSetting />;
    case 'board.crews':
      return <CrewLookSetting />;
    case 'board.notes':
      return <AgentNoteLookSetting />;
    case 'board.tidying':
      return <ArrangeSpacingSetting onError={onError} />;
    case 'agents.chat':
      return <AgentsChatSettings />;
    case 'agents.context':
      return <CompactWindowSetting onError={onError} />;
    case 'agents.links':
      return <ClickableLinksSetting onError={onError} />;
    case 'alerts.notifications':
      return <MutedNotificationsSetting onError={onError} />;
    case 'usage.plan':
      return <UsagePlanSetting />;
    case 'usage.thresholds':
      return <UsageThresholdsSetting onError={onError} />;
    case 'usage.pacing':
      return <UsagePacingSetting onError={onError} />;
    case 'accounts.terminals':
      return <ExternalHooksToggle onError={onError} />;
    case 'advanced.programs':
      return <HarnessPathSettings onError={onError} />;
    case 'advanced.handoffs':
      return <HeldPayloadsSetting onError={onError} />;
    case 'advanced.cli':
      return <CliInstallSetting onError={onError} />;
    case 'advanced.webTabs':
      return <WebTabsSetting onError={onError} />;
    case 'advanced.service':
      return <DaemonStatusSetting />;
    default:
      return null;
  }
}

/**
 * The Settings window: a sidebar of seven groups, each opening to list its sections, and a page per group with each
 * section's controls in a box under its heading. A section in the sidebar opens its group's page scrolled to it. The
 * window opens on the pane it was asked for (`initial`, from Settings… elsewhere in the app), else the one it last
 * showed, and shows another whenever it is asked again while open.
 *
 * The search field atop the sidebar filters it to the sections that hold what is typed, across groups, and the page to
 * those sections, with what matched highlighted. A section picked there ends the search and opens in its group.
 */
export function SettingsWindow({ initial }: { initial: string }) {
  const [pane, setPane] = useState<SettingsPane>(() => settingsPaneFrom(initial || lastPane.get()));
  const [open, setOpen] = useState<ReadonlySet<SettingsGroupId>>(() => new Set([pane.group]));
  const [query, setQuery] = useState('');
  const simplified = useSimplified();
  const wanted = query.trim();
  const hits = useMemo(() => searchSettings(wanted, { simplified }), [wanted, simplified]);
  const searching = wanted !== '';
  const page = useRef<HTMLDivElement>(null);
  const toasts = useToast();
  const onError = useCallback<OnError>(
    (action) => (error) => void toasts.show({ id: action, tone: 'error', message: `Could not ${action}: ${errorMessage(error)}` }),
    [toasts],
  );

  const show = useCallback((next: SettingsPane) => {
    setQuery('');
    setPane(next);
    setOpen((current) => (current.has(next.group) ? current : new Set([...current, next.group])));
  }, []);

  useEffect(() => window.agentBoard.setup.onSettingsPane((asked) => show(settingsPaneFrom(asked))), [show]);

  // Kept as it changes, and the page brought to the section picked, or to its top.
  useEffect(() => {
    lastPane.set(settingsPaneText(pane));
    const target = pane.section === undefined ? undefined : page.current?.querySelector(`#settings-section-${pane.group}-${pane.section}`);
    if (target) target.scrollIntoView({ block: 'start' });
    else page.current?.scrollTo({ top: 0 });
  }, [pane]);

  useSearchHighlight(page, wanted);

  const group = SETTINGS_GROUPS.find((each) => each.id === pane.group) ?? SETTINGS_GROUPS[0]!;
  return (
    <div className="settings-window">
      <header className="settings-window-bar" data-drag-region>
        <h1 className="settings-window-title">{searching ? 'Search' : group.name}</h1>
      </header>
      <nav className="settings-window-sidebar" aria-label="Settings">
        <label className="settings-search">
          <Search aria-hidden />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || query === '') return;
              event.preventDefault();
              setQuery('');
            }}
          />
        </label>
        {searching && <FoundSections hits={hits} query={wanted} onPick={show} />}
        {(searching ? [] : SETTINGS_GROUPS).map((each) => {
          const expanded = open.has(each.id);
          return (
            <div key={each.id} className="settings-group" data-open={expanded}>
              <button
                type="button"
                className="settings-group-head"
                aria-expanded={expanded}
                onClick={() => {
                  if (!expanded) show({ group: each.id });
                  else
                    setOpen((current) => {
                      const next = new Set(current);
                      next.delete(each.id);
                      return next;
                    });
                }}
              >
                <ChevronRight className="settings-group-chevron" aria-hidden />
                {GROUP_ICONS[each.id]}
                <span>{each.name}</span>
                {!expanded && <span className="settings-group-count">{each.sections.length}</span>}
              </button>
              {expanded && (
                <ul className="settings-group-sections" aria-label={each.name}>
                  {each.sections.map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        className="settings-section-link"
                        aria-current={each.id === pane.group && section.id === (pane.section ?? each.sections[0]!.id) ? 'page' : undefined}
                        onClick={() => show({ group: each.id, section: section.id })}
                      >
                        {section.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <main className="settings-window-page" ref={page} aria-label={searching ? 'Search' : group.name}>
        {searching ? <FoundPage hits={hits} query={wanted} onError={onError} /> : <h2 className="settings-page-title">{group.name}</h2>}
        {(searching ? [] : group.sections).map((section) => {
          const id = `settings-section-${group.id}-${section.id}`;
          return (
            <section key={section.id} id={id} className="settings-page-section" aria-labelledby={`${id}-heading`}>
              <h3 id={`${id}-heading`} className="settings-page-section-title">
                {section.name}
              </h3>
              <div className="settings-box">{sectionBody(`${group.id}.${section.id}`, onError)}</div>
            </section>
          );
        })}
      </main>
    </div>
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The sidebar while searching: each group with a match, open on the sections that hold it, each with its count. */
function FoundSections({ hits, query, onPick }: { hits: readonly SettingsHit[]; query: string; onPick(pane: SettingsPane): void }) {
  if (hits.length === 0) return <p className="settings-search-empty">No settings match.</p>;
  return SETTINGS_GROUPS.filter((group) => hits.some((hit) => hit.group === group)).map((group) => (
    <div key={group.id} className="settings-group" data-open>
      <div className="settings-group-head" data-found>
        {GROUP_ICONS[group.id]}
        <span>{group.name}</span>
      </div>
      <ul className="settings-group-sections" aria-label={group.name}>
        {hits
          .filter((hit) => hit.group === group)
          .map(({ section, controls }) => (
            <li key={section.id}>
              <button type="button" className="settings-section-link" onClick={() => onPick({ group: group.id, section: section.id })}>
                <span>
                  <Marked text={section.name} query={query} />
                </span>
                <span className="settings-group-count">{controls.length}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  ));
}

/** The page while searching: how much matched, then each section that holds it under its place, whole. */
function FoundPage({ hits, query, onError }: { hits: readonly SettingsHit[]; query: string; onError: OnError }) {
  const found = hits.reduce((total, hit) => total + hit.controls.length, 0);
  return (
    <>
      <h2 className="settings-page-title">
        {count(found, 'result')} for “{query}”
      </h2>
      {hits.map(({ group, section }) => {
        const id = `settings-found-${group.id}-${section.id}`;
        return (
          <section key={id} id={id} className="settings-page-section" aria-labelledby={`${id}-heading`}>
            <h3 id={`${id}-heading`} className="settings-found-place">
              {group.name} › {section.name}
            </h3>
            <div className="settings-box">{sectionBody(`${group.id}.${section.id}`, onError)}</div>
          </section>
        );
      })}
    </>
  );
}

/** `text` with the first place it holds `query` marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = searchable(text).indexOf(searchable(query));
  // A name whose letters change length as accents go can't be marked by those places: it is left plain.
  if (at === -1 || searchable(text).length !== text.length) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** The CSS highlight the page's matches are painted with (`::highlight(settings-search)` in chrome.css). */
const SEARCH_HIGHLIGHT = 'settings-search';

/**
 * Paints each place the page's section boxes hold `query`, case and accents aside as searching does, with the search highlight, again as their
 * text changes (a reading that arrives, a hint that grows), and clears it once the query is empty. The controls draw
 * themselves, so the highlight is laid over their text rather than asked of each.
 */
function useSearchHighlight(page: { current: HTMLElement | null }, query: string) {
  useEffect(() => {
    const root = page.current;
    if (root === null || query === '') return;
    const wanted = searchable(query);
    const paint = () => {
      const ranges: Range[] = [];
      for (const box of root.querySelectorAll('.settings-box')) {
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const raw = node.textContent ?? '';
          const text = searchable(raw);
          // Text whose letters change length as accents go can't be painted by those places: it is left plain.
          if (text.length !== raw.length) continue;
          for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + wanted.length)) {
            const range = new Range();
            range.setStart(node, at);
            range.setEnd(node, at + wanted.length);
            ranges.push(range);
          }
        }
      }
      CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges));
    };
    paint();
    const watcher = new MutationObserver(paint);
    watcher.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      watcher.disconnect();
      CSS.highlights.delete(SEARCH_HIGHLIGHT);
    };
  }, [page, query]);
}
