import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Moon, Sun, SunMoon } from 'lucide-react';
import { themeFor, type Appearance } from '../../../shared/appearance';
import { THEME_PACKS, type PackPalette } from '../../../shared/theme-packs';
import { THEMES } from '../../../shared/themes';
import { darkQuery } from '../themes';
import { Choice, Choices, Fieldset, Hint, SectionLabel, Tag } from '../ui';

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

/**
 * A theme pack's look in small, from its palette, as its tokens aren't the page's until it is picked: its desk, with
 * its accent and its running, waiting and failed colours on it.
 */
function PackPreview({ palette }: { palette: PackPalette }) {
  const colours = {
    '--preview-desk': palette.desk,
    '--preview-edge': palette.border,
    '--preview-accent': palette.accent,
    '--preview-running': palette.ok,
    '--preview-waiting': palette.warn,
    '--preview-failed': palette.fail,
  } as CSSProperties;
  return (
    <span className="theme-preview" style={colours} aria-hidden>
      {['accent', 'running', 'waiting', 'failed'].map((role) => (
        <span key={role} className={`theme-preview-dot theme-preview-${role}`} />
      ))}
    </span>
  );
}

/**
 * Settings › Appearance (AO1): System, the default, or any theme in the registry: the app's own two, then the
 * theme packs, each family under its name and credit. The pick is the main process's (main/appearance.ts), which every
 * window follows at once; this shows it, as picked in any window, and changes it.
 */
export function AppearanceSetting({ onError }: { onError(action: string): (error: unknown) => void }) {
  const [appearance, setAppearance] = useState<Appearance>();
  const dark = useDark();
  useEffect(() => {
    const api = window.agentBoard.appearance;
    api.get().then(setAppearance, onError('read the appearance'));
    return api.onChanged(setAppearance);
  }, [onError]);

  const pick = (value: Appearance) => {
    const was = appearance;
    setAppearance(value);
    window.agentBoard.appearance.set(value).catch((error: unknown) => {
      setAppearance(was);
      onError('change the appearance')(error);
    });
  };

  const choices = [
    {
      value: 'system' as const,
      label: (
        <>
          System <Tag tone="accent">default</Tag>
        </>
      ),
      icon: <SunMoon />,
    },
    ...THEMES.filter(({ family }) => family === undefined).map(({ id, name, scheme }) => ({
      value: id,
      label: name,
      icon: scheme === 'dark' ? <Moon /> : <Sun />,
    })),
  ];
  return (
    <>
      <SectionLabel as="h4">Appearance</SectionLabel>
      <Fieldset legend="Theme">
        <Choices aria-label="Theme">
          {choices.map(({ value, label, icon }) => (
            <Choice
              key={value}
              name="appearance"
              mark={icon}
              label={label}
              checked={appearance === value}
              disabled={appearance === undefined}
              onChange={() => pick(value)}
            />
          ))}
        </Choices>
        <Hint>
          {appearance === undefined || appearance === 'system'
            ? `System follows ${OS}, which is ${dark ? 'dark' : 'light'} right now.`
            : `${themeFor(appearance, dark).name} whatever ${OS} is set to.`}
        </Hint>
      </Fieldset>
      <Fieldset legend="Theme packs" className="theme-packs">
        {THEME_PACKS.map(({ family, credit, themes }) => (
          <div key={family} className="theme-pack">
            <p className="theme-pack-name">{family}</p>
            <p className="theme-pack-credit">{credit}</p>
            {/* A radio group of its own, by its own name: one Tab stop, its arrow keys staying within the family. */}
            <div className="theme-picks" role="radiogroup" aria-label={family}>
              {themes.map(({ id, name, scheme, palette }) => (
                <Choice
                  key={id}
                  className="theme-pick"
                  name={`appearance-${family}`}
                  mark={<PackPreview palette={palette} />}
                  label={name}
                  detail={scheme === 'dark' ? 'Dark' : 'Light'}
                  checked={appearance === id}
                  disabled={appearance === undefined}
                  onChange={() => pick(id)}
                />
              ))}
            </div>
          </div>
        ))}
      </Fieldset>
    </>
  );
}
