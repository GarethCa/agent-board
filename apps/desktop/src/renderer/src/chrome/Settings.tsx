import { ExternalHooksToggle } from '../board/ExternalHooksToggle';
import type { ClickOpens } from '../board/click-opens';
import type { ConnectionsView } from '../board/connections-view';
import type { CrewLook } from '../board/crew-view';
import type { AgentNoteLook } from '../board/items/agent-note-look';
import { HeldPayloadsSetting } from '../board/HeldPayloadsSetting';
import { CompactWindowSetting } from './CompactWindowSetting';
import { HarnessPathSettings } from './HarnessPathSettings';
import { daemonStatusText, type DaemonStatusValue } from '../DaemonStatus';
import { Choice, Choices, Fieldset, Hint, SectionLabel, Segmented, Tag } from '../ui';
import { AppearanceSetting } from './AppearanceSetting';
import { CliInstallSetting } from './CliInstallSetting';
import { KeyboardSetting } from './KeyboardSetting';
import { keyText } from '../keys/registry';

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
  /** Which connections the board draws, and picks it. */
  connections: ConnectionsView;
  onConnections(value: ConnectionsView): void;
  /** How agent notes look (CO2 or CO1), and picks it. */
  agentNoteLook: AgentNoteLook;
  onAgentNoteLook(value: AgentNoteLook): void;
}

/**
 * The app's settings: sessions from other terminals, where held hand-offs are kept, the appearance (System, Light or
 * Dark), the paths of `claude` and `codex`, the context size Claude agents compact at, what a double-click on a tile opens, how an orchestrator's agents show, installing the command line, and the
 * daemon's status, how agent notes look, and whether the extended keyboard shortcuts work.
 */
export function Settings({ status, onError, clickOpens, onClickOpens, crewLook, onCrewLook, connections, onConnections, agentNoteLook, onAgentNoteLook }: SettingsProps) {
  return (
    <div className="settings">
      <ExternalHooksToggle onError={onError} />
      <HeldPayloadsSetting onError={onError} />
      <HarnessPathSettings onError={onError} />
      <CompactWindowSetting onError={onError} />
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
      <Fieldset legend="Show connections">
        <Segmented
          aria-label="Show connections"
          options={[
            { id: 'all', label: 'All' },
            { id: 'handoffs', label: 'Hand-offs only' },
            { id: 'none', label: 'None' },
          ]}
          value={connections}
          onChange={onConnections}
        />
        <Hint>Hiding only changes the view: hand-offs still go. Any object shows how many it has hidden. Its own show while it is selected or hovered, and a moment after, to reach one; a selected one stays. {keyText('move.connections')} cycles them.</Hint>
      </Fieldset>
      <Fieldset legend="Agent notes">
        <Segmented
          aria-label="Agent notes"
          options={[
            { id: 'document', label: 'Document' },
            { id: 'terminal', label: 'Terminal' },
          ]}
          value={agentNoteLook}
          onChange={onAgentNoteLook}
        />
        <Hint>How a note an agent writes looks: a typed card, or a cut of its terminal.</Hint>
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
      <SectionLabel as="h4">Keyboard</SectionLabel>
      <KeyboardSetting />
      <CliInstallSetting onError={onError} />
      <Hint data-testid="daemon-details">{daemonStatusText(status)}</Hint>
    </div>
  );
}
