import { OPENS_ON, OPENS_ON_LABELS, setOpensOn, useOpensOn } from '../session/opens-on';
import { Fieldset, Hint, Segmented } from '../ui';

/** Under the Simplified design: the view an agent's window opens on, until that agent has one picked. */
export function OpensOnSetting() {
  return (
    <Fieldset legend="Agent windows open on">
      <Segmented
        aria-label="Agent windows open on"
        options={OPENS_ON.map((id) => ({ id, label: OPENS_ON_LABELS[id] }))}
        value={useOpensOn()}
        onChange={setOpensOn}
      />
      <Hint>Chat, Timeline and Terminal stay one click away in every agent’s window, and each agent keeps the last one picked. A tile expanded in place opens on its terminal.</Hint>
    </Fieldset>
  );
}
