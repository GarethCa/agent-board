import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, Moon, Search, Sun, SunMoon } from 'lucide-react';
import { choiceFor, missingMode, themeFor, type Appearance, type Mode } from '../../../shared/appearance';
import { THEME_CHOICES, THEMES, type ThemeChoice, type ThemePreview } from '../../../shared/themes';
import { darkQuery } from '../themes';
import { EmptyState, Fieldset, Hint, Input, Popover, Segmented } from '../ui';

/** Whether the window is in dark mode now: the OS's own while the setting is System. */
function useDark(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = darkQuery();
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => darkQuery().matches,
  );
}

/** What the OS is called in the hints: macOS where the app has its inset chrome, else a word for any. */
const OS = window.agentBoard.windows.chrome === 'inset' ? 'macOS' : 'your system';

const MODE_OPTIONS = [
  { id: 'light', label: 'Light', icon: <Sun /> },
  { id: 'dark', label: 'Dark', icon: <Moon /> },
  { id: 'system', label: 'System', icon: <SunMoon /> },
] as const;

const MODE_NAMES: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

const themeNamed = (id: string) => THEMES.find((theme) => theme.id === id)!;

/**
 * A theme's look in small, from its registry preview, as its tokens aren't the page's until it shows: its desk, with
 * its accent and its running, waiting and failed colours on it.
 */
function ThemeSwatch({ preview }: { preview: ThemePreview }) {
  const colours = {
    '--preview-desk': preview.desk,
    '--preview-edge': preview.edge,
    '--preview-accent': preview.accent,
    '--preview-running': preview.running,
    '--preview-waiting': preview.waiting,
    '--preview-failed': preview.failed,
  } as CSSProperties;
  return (
    <span className="theme-swatch" style={colours} aria-hidden>
      {['accent', 'running', 'waiting', 'failed'].map((role) => (
        <span key={role} className={`theme-swatch-dot theme-swatch-${role}`} />
      ))}
    </span>
  );
}

/** What each mode shows of a choice: its themes' own names (Latte · Mocha), else Light · Dark, or Dark only. */
function variants({ family, light, dark }: ThemeChoice): string {
  const named = (id: string, scheme: string) => themeNamed(id).name.replace(family, '').trim() || scheme;
  if (light !== undefined && dark !== undefined) return `${named(light, 'Light')} · ${named(dark, 'Dark')}`;
  return light !== undefined ? 'Light only' : 'Dark only';
}

/** Lower case, accents dropped, so “rose” finds Rosé Pine. */
const folded = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Whether a choice matches what was typed: its name, family, credit or any of its themes' names. */
function matches(choice: ThemeChoice, query: string): boolean {
  const themes = [choice.light, choice.dark].flatMap((id) => (id === undefined ? [] : [themeNamed(id).name]));
  return folded([choice.name, choice.family, choice.credit ?? '', ...themes].join(' ')).includes(folded(query.trim()));
}

/** The choices that match `query`, grouped by family in the registry's order, each family with its credit. */
function familiesMatching(query: string) {
  const families: { family: string; credit?: string; choices: ThemeChoice[] }[] = [];
  for (const choice of THEME_CHOICES.filter((each) => matches(each, query))) {
    const last = families.at(-1);
    if (last?.family === choice.family) last.choices.push(choice);
    else families.push({ family: choice.family, credit: choice.credit, choices: [choice] });
  }
  return families;
}

/**
 * The Theme popover's content: a search field over the choices as cards, grouped by family under each family's credit.
 * Arrow keys move between the cards (↓ from the search field reaches the first), ↵ or Space picks one, which shows at
 * once and keeps the popover open to try another; Esc closes it and gives focus back to its button.
 */
function ThemeList({ picked, onPick }: { picked: string; onPick(theme: string): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(picked);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const search = useRef<HTMLInputElement>(null);
  const families = familiesMatching(query);
  const shown = families.flatMap(({ choices }) => choices.map(({ id }) => id));
  const current = shown.includes(active) ? active : shown[0];

  const focus = (id: string | undefined) => {
    if (id === undefined) return;
    setActive(id);
    cards.current.get(id)?.focus();
  };
  const onCardKey = (event: KeyboardEvent, id: string) => {
    const at = shown.indexOf(id);
    const to = {
      ArrowRight: shown[at + 1],
      ArrowDown: shown[at + 1],
      ArrowLeft: shown[at - 1],
      ArrowUp: shown[at - 1],
      Home: shown[0],
      End: shown.at(-1),
    }[event.key];
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPick(id);
    } else if (to !== undefined) {
      event.preventDefault();
      focus(to);
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowLeft') && at === 0) {
      event.preventDefault();
      search.current?.focus();
    }
  };

  return (
    <div className="theme-list">
      <Input
        ref={search}
        size="sm"
        type="search"
        icon={<Search />}
        aria-label="Search themes"
        placeholder="Search themes…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          focus(current);
        }}
      />
      {families.length === 0 ? (
        <EmptyState framed={false} title="No themes match" />
      ) : (
        <div className="theme-families" role="listbox" aria-label="Themes">
          {families.map(({ family, credit, choices }) => (
            <div key={family} className="theme-family" role="group" aria-label={family}>
              <p className="theme-family-name">
                {family}
                {credit !== undefined && <small>{credit}</small>}
              </p>
              <div className="theme-cards">
                {choices.map((choice) => (
                  <div
                    key={choice.id}
                    ref={(card) => void (card ? cards.current.set(choice.id, card) : cards.current.delete(choice.id))}
                    className="theme-card"
                    role="option"
                    aria-label={choice.name}
                    aria-selected={choice.id === picked}
                    tabIndex={choice.id === current ? 0 : -1}
                    onFocus={() => setActive(choice.id)}
                    onClick={() => onPick(choice.id)}
                    onKeyDown={(event) => onCardKey(event, choice.id)}
                  >
                    <span className="theme-card-previews">
                      {[choice.light, choice.dark].map((id) => id !== undefined && <ThemeSwatch key={id} preview={themeNamed(id).preview} />)}
                    </span>
                    <span className="theme-card-name">{choice.name}</span>
                    <span className="theme-card-variants">{variants(choice)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Settings › General › Appearance: the mode, Light, Dark or System (the default, which follows the OS), then the theme,
 * a button showing the choice that opens the Theme popover. A choice is a family, and the mode picks its light or dark
 * theme; where it has none for the mode, the app's own shows, and a hint says so. The setting is the main process's
 * (main/appearance.ts), which every window follows at once; this shows it, as picked in any window, and changes it.
 */
export function AppearanceSetting({ onError }: { onError(action: string): (error: unknown) => void }) {
  const [appearance, setAppearance] = useState<Appearance>();
  const [open, setOpen] = useState(false);
  const dark = useDark();
  useEffect(() => {
    const api = window.agentBoard.appearance;
    api.get().then(setAppearance, onError('read the appearance'));
    return api.onChanged(setAppearance);
  }, [onError]);

  const pick = (change: Partial<Appearance>) => {
    if (appearance === undefined) return;
    const was = appearance;
    const next = { ...appearance, ...change };
    setAppearance(next);
    window.agentBoard.appearance.set(next).catch((error: unknown) => {
      setAppearance(was);
      onError('change the appearance')(error);
    });
  };

  const choice = appearance && choiceFor(appearance);
  const missing = appearance && missingMode(appearance);
  return (
    <>
      <Fieldset legend="Mode">
        <Segmented aria-label="Mode" options={MODE_OPTIONS} value={appearance?.mode ?? 'system'} onChange={(mode) => pick({ mode })} />
        <Hint>
          {appearance === undefined || appearance.mode === 'system'
            ? `System follows ${OS}, which is ${dark ? 'dark' : 'light'} right now.`
            : `${MODE_NAMES[appearance.mode]} whatever ${OS} is set to.`}
        </Hint>
      </Fieldset>
      <Fieldset legend="Theme">
        <div className="theme-setting">
          <Popover
            open={open}
            onOpenChange={setOpen}
            aria-label="Themes"
            className="theme-popover"
            content={appearance && <ThemeList picked={appearance.theme} onPick={(theme) => pick({ theme })} />}
          >
            <button type="button" className="theme-control" aria-label={`Theme: ${choice?.name ?? ''}`} disabled={appearance === undefined}>
              {appearance && <ThemeSwatch preview={themeFor(appearance, dark).preview} />}
              <span className="theme-control-name">{choice?.name}</span>
              <ChevronDown className="theme-control-chevron" aria-hidden />
            </button>
          </Popover>
        </div>
        {choice && missing && (
          <Hint data-testid="theme-fallback">
            {choice.name} has no {missing} theme, so {missing} mode shows the app&apos;s own.
          </Hint>
        )}
      </Fieldset>
    </>
  );
}
