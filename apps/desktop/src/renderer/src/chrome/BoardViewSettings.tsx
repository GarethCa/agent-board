import { Choice, Choices, Fieldset, Hint, Segmented, Switch, Tag } from '../ui';
import { keyText } from '../keys/registry';
import { PARTS_TO_TURN_ON, tileShowsWith } from '../board/tile-shows';
import { setCrewLook, setViewSetting, useTileShows, useViewSettings } from '../board/view-settings';

/** Settings › Board › Opening tiles: what a double-click on an agent's or shell's tile opens. */
export function ClickOpensSetting() {
  const { clickOpens } = useViewSettings();
  return (
    <Fieldset legend="Double-clicking a tile opens">
      <Hint>For agent and shell tiles. The tile&apos;s ⋯ menu offers the other way, and a Simplified window&apos;s ⋯ menu has Maximise and Restore.</Hint>
      <Choices aria-label="Double-clicking a tile opens">
        <Choice
          name="click-opens"
          label={
            <>
              Session window <Tag tone="accent">default</Tag>
            </>
          }
          detail="Over the board, at the size you left it, with Minimise, Pop out and Close."
          checked={clickOpens === 'window'}
          onChange={() => setViewSetting('clickOpens', 'window')}
        />
        <Choice
          name="click-opens"
          label="Maximised session window"
          detail="The same window, filling the board each time it opens. Restore still shrinks it."
          checked={clickOpens === 'maximised'}
          onChange={() => setViewSetting('clickOpens', 'maximised')}
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

/** Settings › Board › Agent tiles: which parts an agent's Classic tile shows at rest, where the quiet tile hides them. */
export function TileShowsSetting() {
  const tileShows = useTileShows();
  return (
    <Fieldset legend="Tile shows">
      <Hint>An agent&apos;s tile says what it is doing and since when. Turn a part on to keep it on the tile. Off, a part waits for hover or the tile&apos;s hover card, or takes its quieter form.</Hint>
      {PARTS_TO_TURN_ON.map(({ part, label }) => (
        <Switch key={part} label={label} checked={tileShows[part]} onChange={(event) => setViewSetting('tileShows', tileShowsWith(tileShows, part, event.target.checked))} />
      ))}
    </Fieldset>
  );
}

/** Settings › Board › Agent tiles: whether the chat's Expand all and Collapse all always show, or only while the pointer is over the header or tab row they sit in. */
export function ChatRunsShowSetting() {
  const { chatRunsShow } = useViewSettings();
  return (
    <Fieldset legend="Expand all and Collapse all show">
      <Segmented
        aria-label="Expand all and Collapse all show"
        options={[
          { id: 'always', label: 'Always' },
          { id: 'hover', label: 'On hover' },
        ]}
        value={chatRunsShow}
        onChange={(value) => setViewSetting('chatRunsShow', value)}
      />
      <Hint>In an agent&apos;s window and its expanded tile, while the chat shows. On hover, they wait until the pointer is over the header or tab row that holds them.</Hint>
    </Fieldset>
  );
}
