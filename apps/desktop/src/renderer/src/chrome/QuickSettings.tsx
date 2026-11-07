import { useSimplified } from '../design';
import { useTechnicalDetails } from '../technical';
import { Section, Segmented, Switch } from '../ui';
import { useMenuSectionOpen } from './board-menu-fold';
import { CharacterMotionControl, CharacterStyleChoices } from './CharactersSetting';
import { MODE_OPTIONS, useAppearance } from './appearance-mode';
import { useUsageOnBoard } from './usage-on-board';

/** A change that failed leaves the control as the setting still is; the board menu has no place to say so, so the console does. */
const report = (action: string) => (error: unknown) => console.error(`Could not ${action}`, error);

/**
 * The board menu's Quick settings: the few settings worth a click away, each the same setting as its row in the Settings
 * window (Appearance's mode, the Simplified design, Show technical details, Characters and their motion, Show usage on the board), live in every
 * window. Show technical details is there only while the Simplified design is on, as in Settings.
 */
export function QuickSettings() {
  const { appearance, pick } = useAppearance(report);
  const simplified = useSimplified();
  // `useTechnicalDetails()` is true under Classic, which has no switch: the switch is on only under the Simplified design.
  const shown = useTechnicalDetails();
  const [usageOnBoard, setUsageOnBoard] = useUsageOnBoard();
  const [open, setOpen] = useMenuSectionOpen('quick-settings');

  return (
    <Section label="Quick settings" open={open} onOpenChange={setOpen}>
      <div className="quick-settings" data-testid="quick-settings">
        <div className="quick-setting">
          <span className="quick-setting-label">Appearance</span>
          <Segmented
            aria-label="Appearance"
            options={MODE_OPTIONS}
            value={appearance?.mode ?? 'system'}
            disabled={appearance === undefined}
            onChange={(mode) => pick({ mode })}
          />
        </div>
        <Switch
          label="Simplified design"
          checked={simplified}
          onChange={(event) => void window.agentBoard.design.set(event.target.checked ? 'simplified' : 'classic').catch(report('change the design'))}
        />
        {simplified && (
          <Switch
            label="Show technical details"
            checked={shown}
            onChange={(event) => void window.agentBoard.technical.set(event.target.checked).catch(report('change Show technical details'))}
          />
        )}
        <div className="quick-setting quick-setting-characters">
          <span className="quick-setting-label">Characters</span>
          <CharacterStyleChoices />
          <CharacterMotionControl />
        </div>
        <Switch label="Show usage on the board" checked={usageOnBoard} onChange={(event) => setUsageOnBoard(event.target.checked)} />
      </div>
    </Section>
  );
}
