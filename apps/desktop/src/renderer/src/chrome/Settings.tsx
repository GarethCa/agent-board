import { ExternalHooksToggle } from '../board/ExternalHooksToggle';
import type { ClickOpens } from '../board/click-opens';
import type { CrewLook } from '../board/crew-view';
import { HeldPayloadsSetting } from '../board/HeldPayloadsSetting';
import { HarnessPathSettings } from './HarnessPathSettings';
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
  /** How the board shows the agents an orchestrator started, and picks it (BA2 or BA3). */
  crewLook: CrewLook;
  onCrewLook(value: CrewLook): void;
}

/**
 * The app's settings: sessions from other terminals, where held hand-offs are kept, the appearance (System, Light or
 * Dark), the paths of `claude` and `codex`, what a double-click on a tile opens, how an orchestrator's agents show, installing the command line, and the
 * daemon's status.
 */
export function Settings({ status, onError, clickOpens, onClickOpens, crewLook, onCrewLook }: SettingsProps) {
  return (
    <div className="settings">
      <ExternalHooksToggle onError={onError} />
      <HeldPayloadsSetting onError={onError} />
      <HarnessPathSettings onError={onError} />
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
      <Fieldset legend="Agents an orchestrator starts">
        <Choices aria-label="Agents an orchestrator starts">
          <Choice
            name="crew-look"
            label={
              <>
                In a crew frame <Tag tone="accent">default</Tag>
              </>
            }
            detail="Together in a dashed frame beside it, moving with it."
            checked={crewLook === 'frames'}
            onChange={() => onCrewLook('frames')}
          />
          <Choice
            name="crew-look"
            label="With a “from” chip"
            detail="Where they are, each with a chip naming it. Hover to light the family."
            checked={crewLook === 'chips'}
            onChange={() => onCrewLook('chips')}
          />
        </Choices>
      </Fieldset>
      <CliInstallSetting onError={onError} />
      <Hint data-testid="daemon-details">{daemonStatusText(status)}</Hint>
    </div>
  );
}
