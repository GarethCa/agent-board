import { ExternalHooksToggle } from '../board/ExternalHooksToggle';
import type { ClickOpens } from '../board/click-opens';
import { HeldPayloadsSetting } from '../board/HeldPayloadsSetting';
import { daemonStatusText, type DaemonStatusValue } from '../DaemonStatus';
import { Choice, Choices, Fieldset, Hint, SectionLabel, Tag } from '../ui';
import { AppearanceSetting } from './AppearanceSetting';
import { CliInstallSetting } from './CliInstallSetting';

export interface SettingsProps {
  status: DaemonStatusValue;
  /** Shows why a setting could not be read or saved. */
  onError(action: string): (error: unknown) => void;
  /** What a double-click on an agent's or shell tile opens, and picks it (AM1). */
  clickOpens: ClickOpens;
  onClickOpens(value: ClickOpens): void;
}

/**
 * The app's settings: sessions from other terminals, where held hand-offs are kept, the appearance (System, Light or
 * Dark), what a double-click on a tile opens, installing the command line, and the daemon's status.
 */
export function Settings({ status, onError, clickOpens, onClickOpens }: SettingsProps) {
  return (
    <div className="settings">
      <ExternalHooksToggle onError={onError} />
      <HeldPayloadsSetting onError={onError} />
      <AppearanceSetting onError={onError} />
      <SectionLabel as="h4">Board</SectionLabel>
      <Fieldset legend="Double-clicking a tile opens">
        <Hint>For agent and shell tiles. The tile&apos;s ⋯ menu does the other one.</Hint>
        <Choices aria-label="Double-clicking a tile opens">
          <Choice
            name="click-opens"
            label={
              <>
                Session window <Tag tone="accent">default</Tag>
              </>
            }
            detail="Over the board, with Minimise, Pop out and Close."
            checked={clickOpens === 'window'}
            onChange={() => onClickOpens('window')}
          />
          <Choice
            name="click-opens"
            label="Expand in place"
            detail="Grows the tile on the board. The tiles around it stay in view."
            checked={clickOpens === 'expand'}
            onChange={() => onClickOpens('expand')}
          />
        </Choices>
      </Fieldset>
      <CliInstallSetting onError={onError} />
      <Hint data-testid="daemon-details">{daemonStatusText(status)}</Hint>
    </div>
  );
}
