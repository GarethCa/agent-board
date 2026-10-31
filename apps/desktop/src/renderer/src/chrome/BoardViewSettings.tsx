import { Choice, Choices, Fieldset, Hint, Segmented, Tag } from '../ui';
import { keyText } from '../keys/registry';
import { setCrewLook, setViewSetting, useViewSettings } from '../board/view-settings';

/** Settings › Board › Opening tiles: what a double-click on an agent's or shell's tile opens. */
export function ClickOpensSetting() {
  const { clickOpens } = useViewSettings();
  return (
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
          onChange={() => setViewSetting('clickOpens', 'window')}
        />
        <Choice
          name="click-opens"
          label="Expand in place"
          detail="Grows the tile on the board. The tiles around it stay in view."
          checked={clickOpens === 'expand'}
          onChange={() => setViewSetting('clickOpens', 'expand')}
        />
      </Choices>
    </Fieldset>
  );
}

/** Settings › Board › Connections: which connections the board draws, the saved default the board's View button also sets. */
export function ConnectionsSetting() {
  const { connections } = useViewSettings();
  return (
    <Fieldset legend="Show connections">
      <Segmented
        aria-label="Show connections"
        options={[
          { id: 'all', label: 'All' },
          { id: 'handoffs', label: 'Hand-offs only' },
          { id: 'none', label: 'None' },
        ]}
        value={connections}
        onChange={(value) => setViewSetting('connections', value)}
      />
      <Hint>
        Hiding only changes the view: hand-offs still go. Any object shows how many it has hidden. Its own show while it is selected or hovered, and a moment
        after, to reach one; a selected one stays. {keyText('move.connections')} cycles them.
      </Hint>
    </Fieldset>
  );
}

/** Settings › Board › Crews: how the agents an orchestrator starts show, the saved default the board's View button also sets. */
export function CrewLookSetting() {
  const { crewLook } = useViewSettings();
  return (
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
          onChange={() => setCrewLook('frames')}
        />
        <Choice
          name="crew-look"
          label="With a “from” chip"
          detail="Where they are, each with a chip naming it. Hover to light the family."
          checked={crewLook === 'chips'}
          onChange={() => setCrewLook('chips')}
        />
        <Choice
          name="crew-look"
          label="Off"
          detail="No frame and no chip. Hover the orchestrator to light its crew."
          checked={crewLook === 'off'}
          onChange={() => setCrewLook('off')}
        />
      </Choices>
    </Fieldset>
  );
}

/** Settings › Board › Agent notes: whether a note an agent writes is a typed card or a cut of its terminal. */
export function AgentNoteLookSetting() {
  const { agentNoteLook } = useViewSettings();
  return (
    <>
      <Segmented
        aria-label="Agent notes"
        options={[
          { id: 'document', label: 'Document' },
          { id: 'terminal', label: 'Terminal' },
        ]}
        value={agentNoteLook}
        onChange={(value) => setViewSetting('agentNoteLook', value)}
      />
      <Hint>How a note an agent writes looks: a typed card, or a cut of its terminal.</Hint>
    </>
  );
}
